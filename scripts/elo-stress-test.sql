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
--   3. question-ELO nudge: clamp, upward-on-wrong, fast-answer exclusion
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
    if r.points_awarded <> -cfg.wrong_penalty then
      raise exception 'q%: wrong answer scored % (want %)', qi, r.points_awarded, -cfg.wrong_penalty;
    end if;
  end loop;
  raise notice 'PASS 2: 9 questions scored shuffle-consistently for both players';
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

-- ── 3. question-ELO: clamp, upward-on-wrong, fast-answer exclusion ──────────
do $$
declare
  mid uuid := (select v::uuid from _t where k = 'mid');
  m matches%rowtype; q questions%rowtype;
begin
  select * into m from matches where id = mid;
  -- A's correct answers all landed at taken_ms = 0 (< 2s) -> suspects, excluded
  -- from the ELO nudge. B's wrong answers are real signal -> elo must have
  -- moved UP from 1200. Both paths bump times_seen.
  for i in 1..9 loop
    select * into q from questions where id = m.question_ids[i];
    if q.elo < 400 or q.elo > 2800 then raise exception 'q% elo % outside clamp', i, q.elo; end if;
    if q.elo <= 1200 then
      raise exception 'q% elo % did not rise (wrong answer must push up; fast correct excluded)', i, q.elo;
    end if;
    if q.times_seen <> 2 then raise exception 'q% times_seen % (want 2)', i, q.times_seen; end if;
  end loop;
  if (select count(*) from match_events where match_id = mid and event_type = 'fast_answer') <> 9 then
    raise exception 'expected 9 fast_answer telemetry rows for A''s 0ms answers';
  end if;
  raise notice 'PASS 3: question-ELO clamp, upward nudge on wrong, fast-answer exclusion + telemetry';
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

rollback;
