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
--  13. TITA: no options, wrong = 0 (no negative marking), blank = skip,
--      numeric tolerance, reveal; finalize_match's TITA margin span
--  14. answer privacy (own-rows RLS), bot matches calibrate the question
--      bank, bot skip discipline on MCQ / never on TITA
--  15. the bot is absent from every list of real users: leaderboard,
--      friend search, spectate browser
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

  -- q_started_a/b feed the self-paced per-player clock (20260718010000); with
  -- now() frozen in-txn they give taken_ms = 0, exactly like the shared clock did.
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       q_started_a, q_started_b)
  select ua, ub, 'active', true, qids, pa.elo, pb.elo, 0, now(), now(), now()
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

  -- 7b: self-paced — opponent answered Q0 and is legitimately working through
  -- Q1 WITHIN its deadline (their own clock q_started_b is fresh). Presence is
  -- judged by that deadline, so the forfeit is 'too early', not granted.
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       q_started_b)
  values (uc, ud, 'active', true, qids, 1000, 1000, 1, now(), now())
  returning id into mid;
  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (mid, ud, qids[1], 0, 0, true, 100, 40000);  -- ud answered Q0, now on Q1
  raised := false;
  begin
    perform forfeit_match(mid);
  exception when others then
    raised := true;
    if position('too early' in sqlerrm) = 0 then
      raise exception '7b: wrong error: %', sqlerrm;
    end if;
  end;
  if not raised then raise exception '7b: forfeit vs a present (within-deadline) opponent was ALLOWED'; end if;

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

-- ── 13. TITA (type-in-the-answer) questions (20260716130000) ────────────────
-- TITA has no options and NO negative marking. Guards:
--   a. get_match_question serves options=[] + qtype='tita' (never answer_value)
--   b. correct typed answer scores base + max bonus (parity with MCQ: 140)
--   c. WRONG typed answer scores 0 — never the MCQ derived penalty. A regression
--      here (e.g. reusing the /(n_opts-1) branch) divides by -1 and REWARDS a
--      wrong answer.
--   d. blank/whitespace entry is a skip (answer_text null), not a wrong answer
--   e. numeric tolerance: '50.0' == '50'
--   f. reveal exposes answer_value + my_answer_text; correct_index is null
do $$
declare
  ug uuid := gen_random_uuid();
  uh uuid := gen_random_uuid();
  qids uuid[]; mid3 uuid;
  opts jsonb; v_qtype text;
  r match_answers%rowtype;
  rev record;
  cfg section_config%rowtype;
  maxpts int;
begin
  insert into auth.users (id, aud, role, email)
  values (ug, 'authenticated', 'authenticated', 'stress-g@test.local'),
         (uh, 'authenticated', 'authenticated', 'stress-h@test.local');
  insert into profiles (id, username, display_name)
  values (ug, 'stress_g', 'G'), (uh, 'stress_h', 'H')
  on conflict (id) do nothing;

  insert into questions (section, difficulty, body, options, correct_index, explanation, elo, qtype, answer_value)
  select 'QUANT', 3, 'stress tita' || g, '[]'::jsonb, 0, 'because', 1200, 'tita', '50'
  from generate_series(1, 9) g;
  select array_agg(id order by body) into qids from questions where body like 'stress tita%';

  select * into cfg from section_config where section = 'QUANT';
  maxpts := cfg.base_points + round(cfg.speed_mult * floor(cfg.cap_ms::numeric / cfg.grace_block_ms))::int;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ug, uh, 'active', false, qids, 1000, 1000, 0, now())
  returning id into mid3;

  -- (a) no options, qtype flagged
  perform set_config('request.jwt.claims', json_build_object('sub', ug, 'role', 'authenticated')::text, true);
  select options, qtype into opts, v_qtype from get_match_question(mid3, 0::smallint);
  if v_qtype <> 'tita' then raise exception '13a: qtype % <> tita', v_qtype; end if;
  if jsonb_array_length(opts) <> 0 then
    raise exception '13a: tita served % options (want 0)', jsonb_array_length(opts);
  end if;

  -- (b) correct typed answer -> base + max bonus, stored as text, no option index
  perform submit_answer(mid3, 0::smallint, null::smallint, '50');
  select * into r from match_answers where match_id = mid3 and user_id = ug and question_index = 0;
  if not r.is_correct then raise exception '13b: correct tita answer scored WRONG'; end if;
  if r.points_awarded <> maxpts then
    raise exception '13b: correct tita scored % (want % = base + max bonus)', r.points_awarded, maxpts;
  end if;
  if r.answer_text is distinct from '50' then raise exception '13b: answer_text % not persisted', r.answer_text; end if;
  if r.selected_index is not null then raise exception '13b: tita stored a selected_index'; end if;

  -- (c) wrong typed answer -> exactly 0. NEVER negative, never positive.
  perform set_config('request.jwt.claims', json_build_object('sub', uh, 'role', 'authenticated')::text, true);
  perform submit_answer(mid3, 0::smallint, null::smallint, '51');
  select * into r from match_answers where match_id = mid3 and user_id = uh and question_index = 0;
  if r.is_correct then raise exception '13c: wrong tita answer scored CORRECT'; end if;
  if r.points_awarded <> 0 then
    raise exception '13c: wrong tita scored % (want 0 — TITA has no negative marking)', r.points_awarded;
  end if;

  -- (d) blank entry is a skip, not a wrong answer
  perform set_config('request.jwt.claims', json_build_object('sub', ug, 'role', 'authenticated')::text, true);
  perform submit_answer(mid3, 1::smallint, null::smallint, '   ');
  select * into r from match_answers where match_id = mid3 and user_id = ug and question_index = 1;
  if r.answer_text is not null then raise exception '13d: blank entry stored answer_text %', r.answer_text; end if;
  if r.is_correct or r.points_awarded <> 0 then raise exception '13d: blank entry not treated as a skip'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uh, 'role', 'authenticated')::text, true);
  perform submit_answer(mid3, 1::smallint, null::smallint, null);

  -- (e) numeric tolerance
  perform set_config('request.jwt.claims', json_build_object('sub', ug, 'role', 'authenticated')::text, true);
  perform submit_answer(mid3, 2::smallint, null::smallint, ' 50.0 ');
  select * into r from match_answers where match_id = mid3 and user_id = ug and question_index = 2;
  if not r.is_correct then raise exception '13e: 50.0 did not match answer_value 50'; end if;

  -- (f) reveal: answer_value + my typed answer, no display index
  select * into rev from get_answer_reveal(mid3, 0::smallint);
  if rev.correct_index is not null then raise exception '13f: tita reveal returned a correct_index'; end if;
  if rev.qtype <> 'tita' then raise exception '13f: reveal qtype % <> tita', rev.qtype; end if;
  if rev.answer_value <> '50' then raise exception '13f: reveal answer_value % <> 50', rev.answer_value; end if;
  if rev.my_answer_text <> '50' then raise exception '13f: reveal my_answer_text % <> 50', rev.my_answer_text; end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 13: TITA — no options, correct=base+bonus, wrong=0 (no negative marking), blank=skip, numeric tolerance, reveal';
end $$;

-- ── 13g. finalize_match margin factor for TITA ──────────────────────────────
-- The per-question max margin is (base+bonus)*(1 + 1/(n_opts-1)) for MCQ. TITA
-- has options=[] -> n_opts=0 -> 1 + 1/greatest(-1,1) = 2, which WRONGLY assumes
-- a symmetric penalty TITA doesn't have and inflates FULL, shrinking every ELO
-- delta. Correct multiplier is 1.0 (span is base+bonus down to 0).
--
-- Constructed so the margin ratio stays BELOW the clamp, making the multiplier
-- observable: A correct on 1 of 9 TITA, everything else a skip.
--   margin = 140; FULL = 0.2 * 9 * 140 * mult
--   mult=1.0 (correct): ratio=0.5556 -> factor=0.3+0.7*0.5556=0.6889 -> +14
--   mult=2.0 (bug):     ratio=0.2778 -> factor=0.3+0.7*0.2778=0.4944 -> +10
do $$
declare
  ui uuid := gen_random_uuid();
  uj uuid := gen_random_uuid();
  qids uuid[]; mid4 uuid;
  elo_i_before int; elo_i_after int; elo_j_after int; delta int;
begin
  insert into auth.users (id, aud, role, email)
  values (ui, 'authenticated', 'authenticated', 'stress-i@test.local'),
         (uj, 'authenticated', 'authenticated', 'stress-j@test.local');
  insert into profiles (id, username, display_name)
  values (ui, 'stress_i', 'I'), (uj, 'stress_j', 'J')
  on conflict (id) do nothing;

  select array_agg(id order by body) into qids from questions where body like 'stress tita%';
  select elo into elo_i_before from profiles where id = ui;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ui, uj, 'active', true, qids, elo_i_before, elo_i_before, 0, now())
  returning id into mid4;

  for qi in 0..8 loop
    perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
    if qi = 0 then
      perform submit_answer(mid4, qi::smallint, null::smallint, '50');   -- the only correct answer
    else
      perform submit_answer(mid4, qi::smallint, null::smallint, null);   -- skip
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', uj, 'role', 'authenticated')::text, true);
    perform submit_answer(mid4, qi::smallint, null::smallint, null);     -- skip
  end loop;
  perform set_config('request.jwt.claims', null, true);

  if (select status from matches where id = mid4) <> 'completed' then
    raise exception '13g: match did not finalize (status %)', (select status from matches where id = mid4);
  end if;

  select elo into elo_i_after from profiles where id = ui;
  select elo into elo_j_after from profiles where id = uj;
  delta := elo_i_after - elo_i_before;

  if delta <> 14 then
    raise exception '13g: winner delta % (want 14). A delta of 10 means finalize_match used the MCQ (1 + 1/(n-1)) = 2 multiplier for a TITA question', delta;
  end if;
  if (elo_i_after - elo_i_before) <> (elo_i_before - elo_j_after) then
    raise exception '13g: rating not zero-sum (+% / -%)', delta, elo_i_before - elo_j_after;
  end if;

  raise notice 'PASS 13g: finalize_match margin uses the TITA (no-penalty) span — winner +14, zero-sum';
end $$;

-- ── 14. answer privacy + bot calibration + bot skip (20260716160000) ─────────
-- Guards:
--   a. answers_read RLS is OWN-ROWS. Before the fix the policy was match-scoped,
--      so a participant could read the opponent's row while the question was
--      still open — and TITA's answer_text is PLAINTEXT, i.e. whoever answered
--      first handed the other player the answer, on rated matches.
--   b. an unrated BOT match DOES nudge question elo. The bot is the cold-start
--      tool and derives its own difficulty from q.elo — gating the nudge on
--      is_rated left the bank permanently at its hand-seeded values.
--      (Section 3 still guards that an unrated PLAYER match never nudges.)
--   c. the bot NEVER skips a TITA: no negative marking means attempting is
--      strictly better. A regression that skips TITA throws away free points.
--   d. every bot row — skip included — carries a NON-NULL time_taken_ms. Null
--      time is the cron's absence marker that forfeit_match reads as proof.
--   e. the bot DOES skip some of its wrong MCQ answers. Never-skip made it
--      farmable by any human with skip discipline (EV ~+8/question vs ~+35).
do $$
declare
  bot_id  uuid := '00000000-0000-0000-0000-00000000b071';
  ua      uuid := (select v::uuid from _t where k = 'ua');
  ub      uuid := (select v::uuid from _t where k = 'ub');
  mid     uuid := (select v::uuid from _t where k = 'mid');
  uk      uuid := gen_random_uuid();
  qids    uuid[]; tqids uuid[];
  mid5    uuid; mid6 uuid;
  q       questions%rowtype;
  r       match_answers%rowtype;
  opts    jsonb; wrong_disp int;
  elo_before int; elo_after int;
  visible int; skips int; wrongs int;
begin
  -- (a) RLS: own rows only. Runs under the real `authenticated` role — the rest
  -- of the harness runs as owner and bypasses RLS entirely.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into visible from match_answers where match_id = mid;
  if visible <> 9 then
    raise exception '14a: participant sees % match_answers rows (want 9 = own only; 18 = the opponent leak)', visible;
  end if;
  if exists (select 1 from match_answers where match_id = mid and user_id = ub) then
    raise exception '14a: opponent answer rows are readable — TITA answer_text leaks the answer live';
  end if;
  reset role;
  perform set_config('request.jwt.claims', null, true);

  insert into auth.users (id, aud, role, email)
  values (uk, 'authenticated', 'authenticated', 'stress-k@test.local');
  insert into profiles (id, username, display_name)
  values (uk, 'stress_k', 'K')
  on conflict (id) do nothing;
  -- handle_new_user may already have created the profile with its own
  -- slugified username, so the on-conflict above is a no-op and 'stress_k' is
  -- NOT necessarily this profile's username. Hand the id to section 15 rather
  -- than letting it look one up by name.
  insert into _t values ('uk', uk::text);

  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select 'QUANT', 3, 'stress bot q' || g, '["w","x","y","z"]'::jsonb, 0, 'because', 1200
  from generate_series(1, 9) g;
  select array_agg(id order by body) into qids from questions where body like 'stress bot q%';

  -- (b) a real (30s) wrong answer by the HUMAN in an unrated BOT match nudges up.
  select elo into elo_before from questions where id = qids[1];
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uk, bot_id, 'active', false, qids, 1000, 1000, 0, now() - interval '30 seconds')
  returning id into mid5;

  perform set_config('request.jwt.claims', json_build_object('sub', uk, 'role', 'authenticated')::text, true);
  select * into q from questions where id = qids[1];
  select options into opts from get_match_question(mid5, 0::smallint);
  select ord - 1 into wrong_disp
  from jsonb_array_elements(opts) with ordinality e(val, ord)
  where val <> q.options -> q.correct_index limit 1;
  perform submit_answer(mid5, 0::smallint, wrong_disp::smallint);

  select elo into elo_after from questions where id = qids[1];
  if elo_after <= elo_before then
    raise exception '14b: bot match did not nudge question elo (% -> %). The bank never calibrates if the nudge stays gated on is_rated', elo_before, elo_after;
  end if;

  -- (c)+(d) bot on TITA: always attempts, stamps a time, and writes a PLAUSIBLE
  -- wrong answer — a real value from the bank, never a function of the correct
  -- one. Distinct answer_values (41..48) so there is something to borrow.
  -- 8 seeds: P(all 8 correct) at 1000 vs elo 1200 is ~3e-5, so the wrong branch
  -- is effectively guaranteed to be exercised.
  insert into questions (section, difficulty, body, options, correct_index, explanation, elo, qtype, answer_value)
  select 'QUANT', 3, 'stress bot tita' || g, '[]'::jsonb, 0, 'because', 1200, 'tita', (40 + g)::text
  from generate_series(1, 8) g;
  select array_agg(id order by body) into tqids from questions where body like 'stress bot tita%';

  wrongs := 0;
  for i in 1..8 loop
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (uk, bot_id, 'active', false, tqids, 1000, 1000, 0, now() - interval '200 seconds')
    returning id into mid6;
    perform bot_act(mid6);

    select * into r from match_answers
    where match_id = mid6 and user_id = bot_id and question_index = 0;
    if not found then raise exception '14c: bot did not act on a TITA'; end if;
    if r.answer_text is null then
      raise exception '14c: bot SKIPPED a TITA — no negative marking means attempting is strictly better';
    end if;
    if r.time_taken_ms is null then
      raise exception '14d: bot TITA row has null time_taken_ms — that is the cron absence marker forfeit_match reads';
    end if;

    if not r.is_correct then
      wrongs := wrongs + 1;
      if tita_matches(r.answer_text, (select answer_value from questions where id = tqids[1])) then
        raise exception '14c: bot wrote the CORRECT answer on a row flagged wrong (%)', r.answer_text;
      end if;
      -- The whole point: a wrong answer must be a real number from the bank,
      -- not `answer_value || '.5'` (implausible, and invertible to the answer).
      if not exists (
        select 1 from questions t
        where t.qtype = 'tita' and t.is_active and t.answer_value = r.answer_text
      ) then
        raise exception '14c: bot wrong TITA answer % is not a plausible bank value', r.answer_text;
      end if;
    end if;
  end loop;
  if wrongs = 0 then
    raise exception '14c: bot got all 8 TITAs right at 1000 vs elo 1200 — the wrong branch went untested';
  end if;

  -- (e) across 16 independent (match, question) seeds the bot must skip some of
  -- its wrong MCQ answers. Skip odds are 0.7 per wrong answer and P(wrong) ~
  -- 0.76 at 1000 vs a 1200 question, so ~53% skip: skips=0 has probability
  -- ~1e-6 and means the never-skip regression is back.
  -- bot_act is rate-limited 30/10s and now() is frozen in this txn, so the two
  -- loops must stay under 30 calls total (8 + 16 = 24).
  skips := 0; wrongs := 0;
  for i in 1..16 loop
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (uk, bot_id, 'active', false, qids, 1000, 1000, 0, now() - interval '200 seconds')
    returning id into mid6;
    perform bot_act(mid6);
    select * into r from match_answers
    where match_id = mid6 and user_id = bot_id and question_index = 0;
    if not r.is_correct then
      wrongs := wrongs + 1;
      if r.selected_index is null then
        skips := skips + 1;
        if r.points_awarded <> 0 then
          raise exception '14e: bot skip scored % points (want 0)', r.points_awarded;
        end if;
        if r.time_taken_ms is null then
          raise exception '14e: bot skip row has null time_taken_ms';
        end if;
      end if;
    end if;
  end loop;
  perform set_config('request.jwt.claims', null, true);

  if wrongs = 0 then raise exception '14e: bot got all 16 right at 1000 vs elo 1200 — check bot_hash_unit'; end if;
  if skips = 0 then
    raise exception '14e: bot skipped 0 of % wrong MCQ answers — a never-skip bot is farmable by skip discipline alone', wrongs;
  end if;
  if skips = 16 then
    raise exception '14e: bot skipped every question — it should still guess sometimes';
  end if;

  raise notice 'PASS 14: answers are own-rows only, bot matches calibrate the bank, bot skips % of % wrong MCQs, and writes plausible bank answers on TITA (never skips it)', skips, wrongs;
end $$;

-- ── 15. the bot never appears in a list of real users ───────────────────────
-- (20260716140000 ladders, 20260716170000 search + spectate.) Three definer
-- readers enumerate profiles; all three are exactly the kind of function that
-- has been silently reverted by a CREATE OR REPLACE from a stale base (see
-- CLAUDE.md migration discipline #1). Each assert is paired with a sanity check
-- that the reader returns real rows, so a filter that accidentally matches
-- EVERYTHING fails here instead of passing vacuously.
do $$
declare
  ua     uuid := (select v::uuid from _t where k = 'ua');
  ub     uuid := (select v::uuid from _t where k = 'ub');
  uk     uuid := (select v::uuid from _t where k = 'uk');
  bot_id uuid := '00000000-0000-0000-0000-00000000b071';
  qids   uuid[]; mid7 uuid; mid8 uuid;
  v_uname text;
begin
  -- (a) leaderboard
  if exists (select 1 from get_leaderboard(100, 0) g where g.username = 'ninja_bot') then
    raise exception '15a: ninja_bot is ranked on the leaderboard';
  end if;
  if not exists (select 1 from get_leaderboard(100, 0)) then
    raise exception '15a: get_leaderboard returned nothing — the assert above is vacuous';
  end if;

  -- (b) friend search. search_profiles filters on auth.uid(), so claims must be
  -- set or `id <> auth.uid()` is NULL and everything drops out.
  -- Search for B's REAL username (handle_new_user may have named the profile,
  -- not the fixture) from A's session — searching your own name returns nothing
  -- by design.
  select username into v_uname from profiles where id = ub;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if exists (select 1 from search_profiles('ninja', 50) s where s.username = 'ninja_bot') then
    raise exception '15b: ninja_bot is friend-searchable — a request to it pends forever';
  end if;
  if not exists (select 1 from search_profiles(v_uname, 50) s where s.username = v_uname) then
    raise exception '15b: search_profiles could not find real user % — the assert above is vacuous', v_uname;
  end if;
  perform set_config('request.jwt.claims', null, true);

  -- (c) spectate browser: a live bot match must not be listed, a live
  -- human-vs-human one must.
  select array_agg(id order by body) into qids from questions where body like 'stress q%';
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (uk, bot_id, 'active', false, qids, 1000, 1000, 0, now())
  returning id into mid7;
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ua, ub, 'active', true, qids, 1000, 1000, 0, now())
  returning id into mid8;

  if exists (select 1 from get_active_matches(100) a where a.match_id = mid7) then
    raise exception '15c: a bot match is listed in the public spectate browser';
  end if;
  if not exists (select 1 from get_active_matches(100) a where a.match_id = mid8) then
    raise exception '15c: get_active_matches dropped a human-vs-human match — the filter is too wide';
  end if;

  raise notice 'PASS 15: ninja_bot absent from the leaderboard, friend search, and the spectate browser';
end $$;

-- ── 16. a match must hold 9 questions — no silent truncation on a content gap ─
-- try_match_internal assembles VARC(3)||DILR(3)||QUANT(3). A section with no
-- active content contributes 0 slots, so the array truncates to <9 and the
-- match corrupts mid-play. The guard (20260718000000) must refuse to pair
-- rather than create a short match; on a content gap both players stay waiting.
do $$
declare
  ul uuid := gen_random_uuid();
  um uuid := gen_random_uuid();
  deactivated uuid[];
  mid uuid;
  qids uuid[];
begin
  insert into auth.users (id, aud, role, email)
  values (ul, 'authenticated', 'authenticated', 'stress-l@test.local'),
         (um, 'authenticated', 'authenticated', 'stress-m@test.local');
  insert into profiles (id, username, display_name, elo)
  values (ul, 'stress_l', 'L', 1200), (um, 'stress_m', 'M', 1200)
  on conflict (id) do nothing;

  -- equal ELO, gap 0 → the base band of 100 pairs them with no back-dating.
  insert into matchmaking_queue (user_id, elo, status)
  values (ul, 1200, 'waiting'), (um, 1200, 'waiting');

  -- 16a: no active content at all → adaptive fill can't reach 9 → guard refuses.
  select array_agg(id) into deactivated from questions where is_active;
  update questions set is_active = false where id = any(deactivated);

  if try_match_internal(ul) is not null then
    raise exception '16a: created a match with zero active content (truncated to <9)';
  end if;
  if exists (select 1 from matches where player_a = ul and player_b = um) then
    raise exception '16a: a truncated match row was inserted';
  end if;
  if (select count(*) from matchmaking_queue where user_id in (ul, um) and status = 'waiting') <> 2 then
    raise exception '16a: queue rows were consumed despite no match being created';
  end if;

  -- 16b: QUANT-only content → adaptive fill rolls all 9 slots into QUANT and
  -- pairs cleanly (VARC/DILR still empty, exactly the current live-test setup).
  update questions set is_active = true where id = any(deactivated) and section = 'QUANT';
  select try_match_internal(ul) into mid;
  if mid is null then raise exception '16b: QUANT-only bank failed to pair'; end if;
  select question_ids into qids from matches where id = mid;
  if coalesce(array_length(qids, 1), 0) <> 9 then
    raise exception '16b: paired match has % questions, expected 9', coalesce(array_length(qids, 1), 0);
  end if;
  if exists (select 1 from unnest(qids) qid join questions q on q.id = qid where q.section <> 'QUANT') then
    raise exception '16b: QUANT-only match pulled a non-QUANT question';
  end if;
  if (select count(*) from matchmaking_queue where user_id in (ul, um) and status = 'matched') <> 2 then
    raise exception '16b: both queue rows were not marked matched';
  end if;

  raise notice 'PASS 16: match refuses <9 on empty content; QUANT-only fills 9 and pairs';
end $$;

-- ── 17. self-paced: each player traverses their own 9; finalize only when both
--       are done (20260718010000) ─────────────────────────────────────────────
do $$
declare
  un uuid := gen_random_uuid();
  uo uuid := gen_random_uuid();
  qids uuid[]; mid uuid; m matches%rowtype;
  q questions%rowtype; opts jsonb; disp int; qi int;
  b_raised boolean;
begin
  insert into auth.users (id, aud, role, email)
  values (un, 'authenticated', 'authenticated', 'stress-n@test.local'),
         (uo, 'authenticated', 'authenticated', 'stress-o@test.local');
  insert into profiles (id, username, display_name, elo)
  values (un, 'stress_n', 'N', 1200), (uo, 'stress_o', 'O', 1200)
  on conflict (id) do nothing;

  select array_agg(id) into qids from (
    select id from questions where section = 'QUANT' and qtype = 'mcq' and is_active limit 9
  ) s;
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at,
                       q_started_a, q_started_b)
  values (un, uo, 'active', true, qids, 1200, 1200, 0, now(), now(), now())
  returning id into mid;

  -- N races ahead: answers all 9 correctly while O has answered nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', un, 'role', 'authenticated')::text, true);
  for qi in 0..8 loop
    select * into q from questions where id = qids[qi + 1];
    select options into opts from get_match_question(mid, qi::smallint);
    select ord - 1 into disp from jsonb_array_elements(opts) with ordinality e(val, ord)
    where val = q.options -> q.correct_index;
    perform submit_answer(mid, qi::smallint, disp::smallint);
  end loop;

  -- N is finished; O has never moved. Match must NOT be finalized yet.
  select * into m from matches where id = mid;
  if m.status <> 'active' then
    raise exception '17: match finalized while O still had 9 questions to answer (status %)', m.status;
  end if;

  -- O is independently still on Q0 — their own clock never advanced with N's.
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  perform get_match_question(mid, 0::smallint);  -- O's current question is Q0
  b_raised := false;
  begin
    perform get_match_question(mid, 1::smallint); -- Q1 is not O's current question
  exception when others then b_raised := true;
  end;
  if not b_raised then raise exception '17: O could read Q1 while still on Q0 (shared advance leaked)'; end if;

  -- N cannot answer past their own 9.
  perform set_config('request.jwt.claims', json_build_object('sub', un, 'role', 'authenticated')::text, true);
  b_raised := false;
  begin
    perform submit_answer(mid, 9::smallint, null); -- N has no 10th question
  exception when others then b_raised := true;
  end;
  if not b_raised then raise exception '17: N answered a 10th question'; end if;

  -- O now finishes (all skips). Only now does the match finalize.
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  for qi in 0..8 loop
    perform submit_answer(mid, qi::smallint, null);
  end loop;

  perform set_config('request.jwt.claims', null, true);
  select * into m from matches where id = mid;
  if m.status <> 'completed' then
    raise exception '17: match not finalized after BOTH finished (status %)', m.status;
  end if;
  if m.winner_id <> un then
    raise exception '17: N swept 9-0 but winner is %', m.winner_id;
  end if;

  raise notice 'PASS 17: self-paced — players advance independently; finalize waits for both';
end $$;

rollback;
