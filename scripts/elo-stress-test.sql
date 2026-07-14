-- =========================================================
-- ELO pipeline stress harness. Assert-based; raises on any violation,
-- prints NOTICEs on success. Everything runs in one transaction and
-- ROLLS BACK — no state survives. Run against a Supabase BRANCH or local
-- stack (it inserts rows into auth.users inside the rolled-back txn):
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/elo-stress-test.sql
--
-- Sections:
--   1. option_perm round-trip (pure function; safe anywhere, incl. prod)
--   2. full match drive: 2 users, 9 questions, real RPCs via JWT-claim
--      impersonation -> shuffle-consistent scoring, reveal, finalize, zero-sum
--   3. question-ELO nudge: clamp, fast-answer (correct AND wrong) exclusion,
--      real answers nudge, unrated matches never nudge
--   4. overlapping rated finalizes chain off current elo (lost-update fix)
--   5. zero-sum 100-ELO floor (0/0 at floor; capped near floor)
--   6. H1: submit past the deadline forced to a 0-point skip
--   7. C1: forfeit rejected within-deadline & vs a present opponent, granted
--      on server-verified absence (missed deadline w/ no row, or a cron-null
--      skip row on the previous question)
--   8. M5: no-skill (all-skip / all-wrong) rated match completes w/o rating
--   9. M1: profiles self-update RLS freezes current_streak / best_streak
--      (runs under the real `authenticated` role so RLS is enforced)
--  10. draws are zero-sum at K = least(K_a, K_b); streaks reset; history rows
--  11. join_queue rejects callers already in a live match; leave_queue
--      reports whether a row was cancelled; queue_heartbeat liveness
--  12. passage reading time: question_cap_ms extends only the passage
--      opener's clock; the reading window never inflates the speed bonus
--
-- Note on timing: now() is frozen inside a transaction, so every submit lands
-- at taken_ms = 0. That makes all of A's correct answers 'fast_answer'
-- suspects — which section 3 uses to assert the exclusion path.
-- =========================================================

begin;

-- ── 1. option_perm: permutation + display/submit/reveal round-trip ──────────
do $$
declare
  mid uuid; uid uuid; perm int[]; n int; qi int; correct int;
  disp int; roundtrip int;
begin
  for i in 1..500 loop
    mid := gen_random_uuid(); uid := gen_random_uuid();
    n := 2 + (i % 5); qi := i % 9; correct := i % n;
    perm := option_perm(mid, uid, qi, n);

    -- must be a permutation of 0..n-1
    if (select count(distinct v) from unnest(perm) v where v between 0 and n - 1) <> n then
      raise exception 'option_perm not a permutation: %', perm;
    end if;

    -- display position of the canonical correct index (what reveal returns)
    select ord - 1 into disp from unnest(perm) with ordinality u(p, ord) where p = correct;
    -- submitting that display position must map back to canonical (submit_answer's mapping)
    roundtrip := perm[disp + 1];
    if roundtrip <> correct then
      raise exception 'round-trip broken: canonical % -> display % -> %', correct, disp, roundtrip;
    end if;
  end loop;
  raise notice 'PASS 1: option_perm round-trip (500 random cases)';
end $$;

-- ── fixtures ─────────────────────────────────────────────────────────────────
create temp table _t (k text primary key, v text);
do $$
declare
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  qids uuid[];
  mid uuid;
begin
  insert into auth.users (id, aud, role, email)
  values (ua, 'authenticated', 'authenticated', 'stress-a@test.local'),
         (ub, 'authenticated', 'authenticated', 'stress-b@test.local');
  -- direct auth.users insert may or may not fire handle_new_user; ensure profiles
  insert into profiles (id, username, display_name)
  values (ua, 'stress_a', 'A'), (ub, 'stress_b', 'B')
  on conflict (id) do nothing;

  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select (array['VARC','VARC','VARC','DILR','DILR','DILR','QUANT','QUANT','QUANT'])[g]::cat_section,
         3, 'stress q' || g, '["w","x","y","z"]'::jsonb, (g % 4)::smallint, 'because', 1200
  from generate_series(1, 9) g;
  select array_agg(id order by body) into qids from questions where body like 'stress q%';

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  select ua, ub, 'active', true, qids, pa.elo, pb.elo, 0, now()
  from profiles pa, profiles pb where pa.id = ua and pb.id = ub
  returning id into mid;

  insert into _t values ('ua', ua::text), ('ub', ub::text), ('mid', mid::text);
end $$;

-- ── 2. drive the match through the real RPCs ────────────────────────────────
-- A answers every question correctly — located BY TEXT in A's displayed
-- (shuffled) options, submitted as the DISPLAY index. B picks a wrong text.
-- If display order and submit mapping ever disagree (the 20260713030000
-- desync), the is_correct asserts below fail immediately.
do $$
declare
  ua uuid := (select v::uuid from _t where k = 'ua');
  ub uuid := (select v::uuid from _t where k = 'ub');
  mid uuid := (select v::uuid from _t where k = 'mid');
  m matches%rowtype;
  q questions%rowtype;
  cfg section_config%rowtype;
  opts jsonb; disp int; wrong_disp int;
  r record;
begin
  for qi in 0..8 loop
    select * into m from matches where id = mid;
    if m.current_index <> qi then
      raise exception 'expected current_index %, got %', qi, m.current_index;
    end if;
    select * into q from questions where id = m.question_ids[qi + 1];
    select * into cfg from section_config where section = q.section;

    -- player A
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    select options into opts from get_match_question(mid, qi::smallint);
    select ord - 1 into disp
    from jsonb_array_elements(opts) with ordinality e(val, ord)
    where val = q.options -> q.correct_index;
    if disp is null then raise exception 'q%: correct option text missing from displayed options', qi; end if;
    perform submit_answer(mid, qi::smallint, disp::smallint);
    if not (select is_correct from match_answers
            where match_id = mid and user_id = ua and question_index = qi) then
      raise exception 'q%: A picked displayed-correct option %, scored WRONG (shuffle desync!)', qi, disp;
    end if;

    -- player B
    perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
    select options into opts from get_match_question(mid, qi::smallint);
    select ord - 1 into wrong_disp
    from jsonb_array_elements(opts) with ordinality e(val, ord)
    where val <> q.options -> q.correct_index
    limit 1;
    perform submit_answer(mid, qi::smallint, wrong_disp::smallint);
    select * into r from match_answers where match_id = mid and user_id = ub and question_index = qi;
    if r.is_correct then raise exception 'q%: B picked wrong text, scored CORRECT (shuffle desync!)', qi; end if;
    -- time-scaled penalty (20260715000000): -(base + bonus(t)) / (n_opts - 1),
    -- recomputed here from the stored time_taken_ms — a random guess must be
    -- exactly EV-neutral at every t.
    if r.points_awarded <> -round((cfg.base_points
          + round(cfg.speed_mult * floor((coalesce(q.duration_ms, cfg.cap_ms) - r.time_taken_ms)::numeric
                                         / cfg.grace_block_ms)))::numeric
          / (jsonb_array_length(q.options) - 1))::int then
      raise exception 'q%: wrong answer scored % (want time-scaled EV-neutral penalty)', qi, r.points_awarded;
    end if;
  end loop;
  raise notice 'PASS 2: 9 questions scored shuffle-consistently for both players';
end $$;

-- ── 2a. section parity + guess-EV neutrality (20260715000000) ────────────────
-- Every section's max attainable points per question must be equal (CAT
-- weights sections equally), and for 4-option questions the instant-guess
-- expected value must be ~0: (1/4)(base+bonus) - (3/4)(base+bonus)/3 = 0.
do $$
declare
  distinct_max int;
  bad record;
begin
  select count(distinct base_points
               + round(speed_mult * floor(cap_ms::numeric / grace_block_ms))::int)
    into distinct_max from section_config;
  if distinct_max <> 1 then
    raise exception '2a: sections have unequal max points/question (parity broken)';
  end if;

  -- penalty derivation is exact EV-neutrality by construction; assert the
  -- formula's ratio at the extremes for each section (t=0 and t=cap)
  for bad in
    select section, base_points, speed_mult, cap_ms, grace_block_ms from section_config
  loop
    if abs( (bad.base_points + round(bad.speed_mult * floor(bad.cap_ms::numeric / bad.grace_block_ms)))
            - 3 * round((bad.base_points + round(bad.speed_mult * floor(bad.cap_ms::numeric / bad.grace_block_ms)))::numeric / 3) ) > 2 then
      raise exception '2a: % instant-guess EV off neutral by > 0.5 pts', bad.section;
    end if;
  end loop;
  raise notice 'PASS 2a: section parity (equal max/question) + guess-EV ~ 0';
end $$;

-- ── 2b. reveal: display-index consistent with the shuffle ───────────────────
do $$
declare
  ua uuid := (select v::uuid from _t where k = 'ua');
  mid uuid := (select v::uuid from _t where k = 'mid');
  m matches%rowtype; q questions%rowtype;
  perm int[]; r record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select * into m from matches where id = mid;
  select * into q from questions where id = m.question_ids[9];
  select * into r from get_answer_reveal(mid, 8::smallint);
  perm := option_perm(mid, ua, 8, jsonb_array_length(q.options));
  if perm[r.correct_index + 1] <> q.correct_index then
    raise exception 'reveal correct_index % does not point at canonical correct %',
      r.correct_index, q.correct_index;
  end if;
  if not r.is_correct then raise exception 'reveal says A was wrong on q9'; end if;
  raise notice 'PASS 2b: reveal display-index consistent with shuffle';
end $$;

-- ── 2c. finalize + zero-sum ELO ──────────────────────────────────────────────
do $$
declare
  mid uuid := (select v::uuid from _t where k = 'mid');
  ua uuid := (select v::uuid from _t where k = 'ua');
  m matches%rowtype; da int; db int;
begin
  perform set_config('request.jwt.claims', null, true);
  select * into m from matches where id = mid;
  if m.status <> 'completed' then
    raise exception 'match not finalized after 9 answers (status %)', m.status;
  end if;
  if m.winner_id <> ua then raise exception 'A swept 9-0 but winner is %', m.winner_id; end if;
  da := m.elo_a_after - m.elo_a_before;
  db := m.elo_b_after - m.elo_b_before;
  if da <= 0 then raise exception 'winner delta not positive: %', da; end if;
  if da + db <> 0 and m.elo_b_after > 100 then
    raise exception 'ELO not zero-sum off the floor: winner %+, loser %', da, db;
  end if;
  raise notice 'PASS 2c: finalize + zero-sum ELO (winner +%, loser %)', da, db;
end $$;

-- ── 3. question-ELO: clamp, fast exclusion (correct AND wrong), real nudge,
--       unrated never nudges ─────────────────────────────────────────────────
do $$
declare
  ua uuid := (select v::uuid from _t where k = 'ua');
  ub uuid := (select v::uuid from _t where k = 'ub');
  mid uuid := (select v::uuid from _t where k = 'mid');
  m matches%rowtype; q questions%rowtype;
  qids uuid[]; m2 uuid; opts jsonb; wrong_disp int;
  elo_before int; elo_mid int; elo_after int;
begin
  select * into m from matches where id = mid;
  -- Every answer in section 2 landed at taken_ms = 0 (< 2s): A's fast-correct
  -- AND B's fast-wrong are both suspects, excluded from the nudge (fast-wrong
  -- deflation is as manipulable as fast-correct inflation). elo must be
  -- untouched; both paths still bump times_seen.
  for i in 1..9 loop
    select * into q from questions where id = m.question_ids[i];
    if q.elo <> 1200 then
      raise exception 'q% elo % (want 1200 untouched — <2s answers must not nudge)', i, q.elo;
    end if;
    if q.times_seen <> 2 then raise exception 'q% times_seen % (want 2)', i, q.times_seen; end if;
  end loop;
  if (select count(*) from match_events where match_id = mid and event_type = 'fast_answer') <> 9 then
    raise exception 'expected 9 fast_answer telemetry rows for A''s 0ms correct answers';
  end if;

  -- A real (30s) wrong answer in a RATED match must nudge the question UP.
  select question_ids into qids from matches where id = mid;
  select elo into elo_before from questions where id = qids[1];
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ua, ub, 'active', true, qids, 1000, 1000, 0, now() - interval '30 seconds')
  returning id into m2;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select options into opts from get_match_question(m2, 0::smallint);
  select * into q from questions where id = qids[1];
  select ord - 1 into wrong_disp
  from jsonb_array_elements(opts) with ordinality e(val, ord)
  where val <> q.options -> q.correct_index limit 1;
  perform submit_answer(m2, 0::smallint, wrong_disp::smallint);
  select elo into elo_mid from questions where id = qids[1];
  if elo_mid <= elo_before then
    raise exception '3: real 30s wrong answer did not nudge elo up (% -> %)', elo_before, elo_mid;
  end if;
  if elo_mid < 400 or elo_mid > 2800 then raise exception '3: elo % outside clamp', elo_mid; end if;

  -- The same real answer in an UNRATED match must NOT nudge (uncapped
  -- unrated challenges were a collusion channel into the question bank).
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ua, ub, 'active', false, qids, 1000, 1000, 0, now() - interval '30 seconds')
  returning id into m2;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select options into opts from get_match_question(m2, 0::smallint);
  select ord - 1 into wrong_disp
  from jsonb_array_elements(opts) with ordinality e(val, ord)
  where val <> q.options -> q.correct_index limit 1;
  perform submit_answer(m2, 0::smallint, wrong_disp::smallint);
  select elo into elo_after from questions where id = qids[1];
  if elo_after <> elo_mid then
    raise exception '3: unrated match nudged question elo (% -> %)', elo_mid, elo_after;
  end if;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 3: fast answers (correct+wrong) excluded, real answers nudge, unrated never nudges';
end $$;

-- ── 4. overlapping rated matches: second finalize chains off CURRENT elo ────
-- (20260713060000 fix — before it, both matches applied deltas to the
-- creation-time snapshot and the second overwrote the first.)
do $$
declare
  ua uuid := (select v::uuid from _t where k = 'ua');
  ub uuid := (select v::uuid from _t where k = 'ub');
  qids uuid[]; m1 uuid; m2 uuid;
  elo_after_m1 int; cur int; r record;
begin
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');
  update profiles set elo = 1000, matches_played = 50 where id in (ua, ub);

  -- both snapshot elo_before = 1000 at creation
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at, score_a, score_b)
  values (ua, ub, 'active', true, qids, 1000, 1000, 0, now(), 250, 40) returning id into m1;
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at, score_a, score_b)
  values (ua, ub, 'active', true, qids, 1000, 1000, 0, now(), 250, 40) returning id into m2;

  perform finalize_match(m1);
  select elo into elo_after_m1 from profiles where id = ua;

  perform finalize_match(m2);
  select * into r from rating_history where match_id = m2 and user_id = ua;
  if r.elo_before <> elo_after_m1 then
    raise exception 'LOST UPDATE: M2 based on % (want current %)', r.elo_before, elo_after_m1;
  end if;
  select elo into cur from profiles where id = ua;
  if cur <> elo_after_m1 + r.delta then
    raise exception 'M2: profile elo % != % + %', cur, elo_after_m1, r.delta;
  end if;
  if (select elo_a_before from matches where id = m2) <> elo_after_m1 then
    raise exception 'matches.elo_a_before not resynced to true base';
  end if;
  raise notice 'PASS 4: overlapping finalizes chain off current elo';
end $$;

-- ── 5. zero-sum 100-ELO floor ────────────────────────────────────────────────
-- Applied delta is capped at the loser's headroom above 100; winner and loser
-- move by exactly the same amount (0/0 when the loser sits on the floor).
do $$
declare
  ua uuid := (select v::uuid from _t where k = 'ua');
  ub uuid := (select v::uuid from _t where k = 'ub');
  qids uuid[]; mx uuid; m matches%rowtype; da int; db int;
begin
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');

  -- loser exactly at floor: both move 0
  update profiles set elo = 1400 where id = ua;
  update profiles set elo = 100  where id = ub;
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at, score_a, score_b)
  values (ua, ub, 'active', true, qids, 1400, 100, 0, now(), 300, 0) returning id into mx;
  perform finalize_match(mx);
  select * into m from matches where id = mx;
  da := m.elo_a_after - m.elo_a_before; db := m.elo_b_after - m.elo_b_before;
  if da <> 0 or db <> 0 then raise exception 'floored loser: expected 0/0, got %+ / %', da, db; end if;

  -- close ratings (200 vs 105): raw delta ~9 > headroom 5 -> capped +5/-5
  update profiles set elo = 200 where id = ua;
  update profiles set elo = 105 where id = ub;
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at, score_a, score_b)
  values (ua, ub, 'active', true, qids, 200, 105, 0, now(), 300, 0) returning id into mx;
  perform finalize_match(mx);
  select * into m from matches where id = mx;
  da := m.elo_a_after - m.elo_a_before; db := m.elo_b_after - m.elo_b_before;
  if da <> 5 or db <> -5 or m.elo_b_after <> 100 then
    raise exception 'near-floor cap: expected +5/-5 to 100, got %+ / % (after %)', da, db, m.elo_b_after;
  end if;
  raise notice 'PASS 5: zero-sum floor (0/0 at floor; capped +5/-5 near floor)';
end $$;

-- ── fixtures for the audit-fix sections (fresh users so per-user submit
--    rate-limit counts and elo state stay clean under frozen now()) ───────────
do $$
declare
  uc uuid := gen_random_uuid();
  ud uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email)
  values (uc, 'authenticated', 'authenticated', 'stress-c@test.local'),
         (ud, 'authenticated', 'authenticated', 'stress-d@test.local');
  insert into profiles (id, username, display_name, elo, matches_played)
  values (uc, 'stress_c', 'C', 1000, 50), (ud, 'stress_d', 'D', 1000, 50)
  on conflict (id) do nothing;
  insert into _t values ('uc', uc::text), ('ud', ud::text);
end $$;

-- ── 6. H1: a submit past the deadline (+3s slack) scores 0, even if correct ──
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  ud uuid := (select v::uuid from _t where k = 'ud');
  qids uuid[]; mid uuid; q questions%rowtype; opts jsonb; disp int; r record;
begin
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');
  -- question started 200s ago — beyond any section cap (max 120s) + 3s slack
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uc, ud, 'active', true, qids, 1000, 1000, 0, now() - interval '200 seconds')
  returning id into mid;

  select * into q from questions where id = qids[1];
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  select options into opts from get_match_question(mid, 0::smallint);
  select ord - 1 into disp
  from jsonb_array_elements(opts) with ordinality e(val, ord)
  where val = q.options -> q.correct_index;

  -- submit the DISPLAYED-correct option, but late: must be forced to a skip
  perform submit_answer(mid, 0::smallint, disp::smallint);
  select * into r from match_answers where match_id = mid and user_id = uc and question_index = 0;
  if r.points_awarded <> 0 then
    raise exception 'late correct submit scored % pts (want 0)', r.points_awarded;
  end if;
  if r.is_correct then raise exception 'late submit recorded is_correct=true'; end if;
  if r.selected_index is not null then
    raise exception 'late submit stored selected_index % (want null skip)', r.selected_index;
  end if;
  if (select score_c.score_a from matches score_c where id = mid) <> 0 then
    raise exception 'late submit moved the score off 0';
  end if;
  raise notice 'PASS 6: submit past deadline forced to 0-point skip';
end $$;

-- ── 7. C1: forfeit_match requires server-verifiable opponent absence ─────────
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  ud uuid := (select v::uuid from _t where k = 'ud');
  qids uuid[]; mid uuid; m matches%rowtype; da int; db int; raised boolean;
begin
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);

  -- 7a: within the current question deadline -> rejected ('too early')
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uc, ud, 'active', true, qids, 1000, 1000, 0, now()) returning id into mid;
  raised := false;
  begin
    perform forfeit_match(mid);
  exception when others then
    raised := true;
    if position('too early' in sqlerrm) = 0 then
      raise exception '7a: wrong error: %', sqlerrm;
    end if;
  end;
  if not raised then raise exception '7a: forfeit within deadline was ALLOWED'; end if;

  -- 7b: past deadline but opponent HAS answered current question -> rejected
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uc, ud, 'active', true, qids, 1000, 1000, 0, now() - interval '200 seconds')
  returning id into mid;
  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (mid, ud, qids[1], 0, null, false, 0, 90000);  -- ud present (auto-skip row)
  raised := false;
  begin
    perform forfeit_match(mid);
  exception when others then
    raised := true;
    if position('opponent answered' in sqlerrm) = 0 then
      raise exception '7b: wrong error: %', sqlerrm;
    end if;
  end;
  if not raised then raise exception '7b: forfeit vs a present (answered) opponent was ALLOWED'; end if;

  -- 7c: past deadline AND opponent has no row -> forfeit succeeds, caller wins.
  -- (score/correct set so the no-skill guard doesn't kick in — a genuinely
  --  played match that the opponent walked out of.)
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       score_a, correct_a)
  values (uc, ud, 'active', true, qids, 1000, 1000, 0, now() - interval '200 seconds', 118, 1)
  returning id into mid;
  perform forfeit_match(mid);
  select * into m from matches where id = mid;
  if m.status <> 'abandoned' then raise exception '7c: status % (want abandoned)', m.status; end if;
  if m.winner_id <> uc then raise exception '7c: winner % (want present player)', m.winner_id; end if;
  da := m.elo_a_after - m.elo_a_before;
  db := m.elo_b_after - m.elo_b_before;
  if da <= 0 then raise exception '7c: forfeit winner delta not positive: %', da; end if;
  if da + db <> 0 then raise exception '7c: forfeit not zero-sum: %+ / %', da, db; end if;
  if not exists (select 1 from rating_history where match_id = mid and user_id = uc)
     or not exists (select 1 from rating_history where match_id = mid and user_id = ud) then
    raise exception '7c: forfeit missing a rating_history row';
  end if;

  -- 7d: a cron-null skip row (selected NULL, time NULL) on the quitter's
  -- PREVIOUS question is absence evidence — forfeit succeeds immediately,
  -- without waiting out the current question's deadline.
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       score_a, correct_a)
  values (uc, ud, 'active', true, qids, 1000, 1000, 1, now(), 118, 1)
  returning id into mid;
  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (mid, ud, qids[1], 0, null, false, 0, null);  -- cron skip row for ud
  perform forfeit_match(mid);
  select * into m from matches where id = mid;
  if m.status <> 'abandoned' or m.winner_id <> uc then
    raise exception '7d: cron-null absence evidence did not grant forfeit (status %, winner %)', m.status, m.winner_id;
  end if;

  -- 7e: a no-skill rated forfeit (nobody scored anything) ends the match but
  -- transfers NO rating — parity with finalize_match's guard.
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uc, ud, 'active', true, qids, 1000, 1000, 1, now())
  returning id into mid;
  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (mid, ud, qids[1], 0, null, false, 0, null);
  perform forfeit_match(mid);
  select * into m from matches where id = mid;
  if m.status <> 'abandoned' then raise exception '7e: status % (want abandoned)', m.status; end if;
  if m.elo_a_after is not null or exists (select 1 from rating_history where match_id = mid) then
    raise exception '7e: no-skill forfeit still transferred rating';
  end if;
  raise notice 'PASS 7: forfeit — too-early & answered-opponent rejected; absence (deadline or cron-null) granted; no-skill unrated';
end $$;

-- ── 8. M5: no-skill (all-skip / all-wrong) rated match abandons WITHOUT rating
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  ud uuid := (select v::uuid from _t where k = 'ud');
  qids uuid[]; mid uuid; m matches%rowtype;
  elo_c0 int; elo_d0 int; mp_c0 int; mp_d0 int;
begin
  perform set_config('request.jwt.claims', null, true);
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');
  update profiles set elo = 1000, current_streak = 0 where id in (uc, ud);
  select elo, matches_played into elo_c0, mp_c0 from profiles where id = uc;
  select elo, matches_played into elo_d0, mp_d0 from profiles where id = ud;

  -- 0-0, both zero correct: guaranteed draw carrying no skill signal
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       score_a, score_b, correct_a, correct_b)
  values (uc, ud, 'active', true, qids, 1000, 1000, 8, now(), 0, 0, 0, 0)
  returning id into mid;
  perform finalize_match(mid);
  select * into m from matches where id = mid;

  -- no-skill matches abandon (not complete) so the null-winner history filter
  -- hides them — see migration 20260714140000_matchmaking_stats_fixes.
  if m.status <> 'abandoned' then raise exception '8: status % (want abandoned)', m.status; end if;
  if (select elo from profiles where id = uc) <> elo_c0
     or (select elo from profiles where id = ud) <> elo_d0 then
    raise exception '8: all-skip 0-0 changed ELO (draw-farm not blocked)';
  end if;
  if (select matches_played from profiles where id = uc) <> mp_c0
     or (select matches_played from profiles where id = ud) <> mp_d0 then
    raise exception '8: no-skill match still counted matches_played';
  end if;
  if exists (select 1 from rating_history where match_id = mid) then
    raise exception '8: no-skill match wrote rating_history';
  end if;
  raise notice 'PASS 8: all-skip 0-0 rated match abandons with no rating change';
end $$;

-- ── 9. M1: profiles self-update RLS freezes current_streak / best_streak ─────
-- Runs under the actual `authenticated` role so RLS is enforced (the rest of
-- the harness runs as owner and bypasses it).
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  froze boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);

  -- sanity: a non-frozen column IS updatable (proves the role can update at all,
  -- so a later failure is the freeze, not a missing grant)
  update profiles set display_name = 'C2' where id = uc;

  -- best_streak is server-owned: the WITH CHECK must reject this
  froze := false;
  begin
    update profiles set best_streak = 9999 where id = uc;
  exception when insufficient_privilege or check_violation then
    froze := true;
  end;
  if not froze then raise exception '9: client UPDATE of best_streak was ALLOWED'; end if;

  -- and current_streak
  froze := false;
  begin
    update profiles set current_streak = 9999 where id = uc;
  exception when insufficient_privilege or check_violation then
    froze := true;
  end;
  if not froze then raise exception '9: client UPDATE of current_streak was ALLOWED'; end if;

  reset role;
  raise notice 'PASS 9: RLS freezes current_streak/best_streak from client update';
end $$;

-- ── 10. draws are zero-sum at K = least(K_a, K_b) ────────────────────────────
-- The old per-player-K draw minted rating: a K40 newbie at 1000 drawing a
-- K24 veteran at 1600 gained +19 while the veteran lost only −8 (+11 net).
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  ud uuid := (select v::uuid from _t where k = 'ud');
  qids uuid[]; mid uuid; m matches%rowtype; da int; db int;
begin
  perform set_config('request.jwt.claims', null, true);
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');
  update profiles set elo = 1000, matches_played = 5,  current_streak = 3 where id = uc; -- K=40
  update profiles set elo = 1600, matches_played = 50, current_streak = 2 where id = ud; -- K=24

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       score_a, score_b, correct_a, correct_b)
  values (uc, ud, 'active', true, qids, 1000, 1600, 8, now(), 150, 150, 2, 2)
  returning id into mid;
  perform finalize_match(mid);
  select * into m from matches where id = mid;

  if m.status <> 'completed' or m.winner_id is not null then
    raise exception '10: draw not completed winnerless (status %, winner %)', m.status, m.winner_id;
  end if;
  da := m.elo_a_after - m.elo_a_before;
  db := m.elo_b_after - m.elo_b_before;
  if da + db <> 0 then raise exception '10: draw not zero-sum: %+ / % (old per-K minting?)', da, db; end if;
  if da <= 0 then raise exception '10: underdog gained % on a draw vs +600 (want > 0)', da; end if;
  if da > 20 then raise exception '10: draw delta % exceeds least-K bound (24/2 = 12ish)', da; end if;
  if (select current_streak from profiles where id = uc) <> 0
     or (select current_streak from profiles where id = ud) <> 0 then
    raise exception '10: draw did not reset both streaks';
  end if;
  if (select count(*) from rating_history where match_id = mid) <> 2 then
    raise exception '10: draw missing rating_history rows';
  end if;
  raise notice 'PASS 10: draw zero-sum (+%/−%), streaks reset, history written', da, da;
end $$;

-- ── 11. queue guards: live-match lockout, leave_queue report, heartbeat ──────
do $$
declare
  uc uuid := (select v::uuid from _t where k = 'uc');
  ud uuid := (select v::uuid from _t where k = 'ud');
  qids uuid[]; mid uuid; raised boolean; left_ok boolean; hb boolean;
begin
  select question_ids into qids from matches where id = (select v::uuid from _t where k = 'mid');

  -- 11a: a player in an ACTIVE match cannot join the queue
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uc, ud, 'active', true, qids, 1000, 1600, 0, now())
  returning id into mid;
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  raised := false;
  begin
    perform join_queue();
  exception when others then
    raised := true;
    if position('already in a live match' in sqlerrm) = 0 then
      raise exception '11a: wrong error: %', sqlerrm;
    end if;
  end;
  if not raised then raise exception '11a: join_queue ALLOWED while in an active match'; end if;

  -- 11b: leave_queue with no waiting row reports false; after a real join,
  -- heartbeat and leave both report true. (Close every live match uc/ud are
  -- in — earlier sections leave some active — or the 11a guard fires here.)
  update matches set status = 'completed', ended_at = now()
  where (player_a in (uc, ud) or player_b in (uc, ud))
    and status in ('active', 'pending');
  perform set_config('request.jwt.claims', json_build_object('sub', ud, 'role', 'authenticated')::text, true);
  select leave_queue() into left_ok;
  if left_ok then raise exception '11b: leave_queue reported true with no waiting row'; end if;
  perform join_queue();
  if not exists (select 1 from matchmaking_queue where user_id = ud and status = 'waiting') then
    raise exception '11b: join_queue left no waiting row';
  end if;
  select queue_heartbeat() into hb;
  if not hb then raise exception '11b: queue_heartbeat reported false for a waiting row'; end if;
  select leave_queue() into left_ok;
  if not left_ok then raise exception '11b: leave_queue reported false for a waiting row'; end if;
  select queue_heartbeat() into hb;
  if hb then raise exception '11b: queue_heartbeat reported true after leaving'; end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 11: live-match queue lockout; leave_queue/queue_heartbeat report correctly';
end $$;

-- ── 12. passage reading time (20260715010000) ────────────────────────────────
-- question_cap_ms: FIRST question of a passage in the match array gets
-- cap + reading_ms; later questions of the same passage and standalones get
-- the plain cap. The reading window must NOT inflate the speed bonus: an
-- instant correct answer on a passage opener scores exactly base + max bonus
-- (the least(cap - taken, base) term in submit_answer).
do $$
declare
  ue uuid := gen_random_uuid();
  uf uuid := gen_random_uuid();
  pid uuid;
  qids uuid[];
  mid2 uuid;
  cfg section_config%rowtype;
  q questions%rowtype;
  opts jsonb; disp int;
  expected int; got int;
begin
  insert into auth.users (id, aud, role, email)
  values (ue, 'authenticated', 'authenticated', 'stress-e@test.local'),
         (uf, 'authenticated', 'authenticated', 'stress-f@test.local');
  insert into profiles (id, username, display_name)
  values (ue, 'stress_e', 'E'), (uf, 'stress_f', 'F')
  on conflict (id) do nothing;

  insert into passages (section, body) values ('VARC', 'stress passage')
  returning id into pid;
  insert into questions (section, difficulty, body, options, correct_index, explanation, elo, passage_id)
  select 'VARC', 3, 'stress pq' || g, '["w","x","y","z"]'::jsonb, 0, 'because', 1200, pid
  from generate_series(1, 3) g;
  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select (array['DILR','DILR','DILR','QUANT','QUANT','QUANT'])[g]::cat_section,
         3, 'stress sq' || g, '["w","x","y","z"]'::jsonb, 0, 'because', 1200
  from generate_series(1, 6) g;
  select array_agg(id order by body) into qids
  from questions where body like 'stress pq%' or body like 'stress sq%';
  -- 'stress pq1..3' sort after 'sq'? No: 'pq' < 'sq', so passage questions are
  -- indexes 0..2 and the passage opener is index 0.

  select * into cfg from section_config where section = 'VARC';
  if question_cap_ms(qids, 0) <> cfg.cap_ms + cfg.reading_ms then
    raise exception '12: passage opener cap % <> cap_ms + reading_ms %',
      question_cap_ms(qids, 0), cfg.cap_ms + cfg.reading_ms;
  end if;
  if question_cap_ms(qids, 1) <> cfg.cap_ms then
    raise exception '12: second passage question cap % <> plain cap_ms %',
      question_cap_ms(qids, 1), cfg.cap_ms;
  end if;
  select * into cfg from section_config where section = 'DILR';
  if question_cap_ms(qids, 3) <> cfg.cap_ms then
    raise exception '12: standalone cap % <> plain cap_ms %',
      question_cap_ms(qids, 3), cfg.cap_ms;
  end if;

  -- drive the opener: instant correct must score base + max bonus, where max
  -- bonus is derived from the BASE cap (reading window mints no extra points)
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ue, uf, 'active', false, qids, 1000, 1000, 0, now())
  returning id into mid2;

  select * into cfg from section_config where section = 'VARC';
  select * into q from questions where id = qids[1];
  perform set_config('request.jwt.claims', json_build_object('sub', ue, 'role', 'authenticated')::text, true);
  select options into opts from get_match_question(mid2, 0::smallint);
  select ord - 1 into disp
  from jsonb_array_elements(opts) with ordinality e(val, ord)
  where val = q.options -> q.correct_index;
  perform submit_answer(mid2, 0::smallint, disp::smallint);

  expected := cfg.base_points
              + round(cfg.speed_mult * floor(cfg.cap_ms::numeric / cfg.grace_block_ms))::int;
  select points_awarded into got from match_answers
  where match_id = mid2 and user_id = ue and question_index = 0;
  if got <> expected then
    raise exception '12: passage opener instant-correct scored % (want % — reading window must not inflate the bonus)',
      got, expected;
  end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 12: passage reading time — opener cap extended, bonus not inflated';
end $$;

rollback;
