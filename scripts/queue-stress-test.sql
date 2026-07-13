-- =========================================================
-- Queue / matchmaking concurrency stress harness. Assert-based; raises on
-- any violation, prints NOTICEs on success. Everything runs in ONE
-- transaction and ROLLS BACK — no state survives. Run against a Supabase
-- BRANCH or local stack (it inserts rows into auth.users inside the
-- rolled-back txn) — NEVER prod:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/queue-stress-test.sql
--
-- Scenario: 20 users join the queue (serially — see limitation below),
-- join_queue -> try_match pairs them, 9 matches play out through the real
-- RPCs (start_match / get_match_question / submit_answer / maybe_advance /
-- finalize_match), one match takes the advance_timed_out cron path.
--
-- Sections:
--   1. join storm: 20 join_queue calls (u1 joins twice — upsert idempotence);
--      18 in-band users pair into 9 matches, 2 out-of-band outliers stay
--      waiting. Asserts: no self-pairs, no double-pairs (nobody in two live
--      matches), one queue row per user, every 'matched' row points at a real
--      match the user participates in, ELO band respected at pairing time
--      (frozen now() => wait 0s => band = ±100), question_ids frozen at 9.
--   2. join_queue rejects a caller already in a live (pending) match.
--   3. ghost sweep: rematch_waiting cancels a waiting row whose heartbeat is
--      >90s stale, leaves the fresh one waiting.
--   4. start_match: pending -> active, timers set; second call (other player)
--      is a no-op — started_at is NOT re-stamped (double-start guard).
--   5. first-question load: get_match_question(0) renders for BOTH players of
--      every match (options present, started_at set).
--   6. cron path: advance_timed_out inserts the NULL-time skip rows (the cron
--      marker) for both players and advances the match.
--   7. drive all 9 matches to completion: player_a answers every question
--      correctly through the shuffle mapping, player_b wrong (one explicit
--      client skip to prove client skips ALWAYS record time_taken_ms).
--   8. post-hoc accounting: all matches completed with the right winner;
--      player-ELO strictly zero-sum across every rated finalization (exact —
--      nobody near the 100 floor); rating_history complete and consistent
--      with profile deltas; unique (match_id,user_id,question_index) holds;
--      time_taken_ms IS NULL only on the cron-inserted rows; queue table
--      fully accounted (matched/waiting/cancelled, no orphans); W/L/played
--      counters add up.
--
-- Limitations (deliberate, single-session harness):
--   * True SKIP LOCKED contention (two try_match_internal calls in flight at
--     once, each locking its own row and skipping the other's) needs two
--     concurrent sessions and cannot be reproduced inside one transaction.
--     This harness proves the serial-join invariants; the mutual-skip race is
--     a code-review finding (recovered by the rematch_waiting cron <=60s).
--   * advance_timed_out() sweeps ALL active matches in the DB. On a shared
--     dev DB with stale pre-existing active matches those advance too — all
--     rolled back, but keep this off prod regardless.
--   * now() is frozen in a transaction: every wait time is 0s (band = 100),
--     every answer lands at taken_ms = 0 (all are fast_answer suspects, so
--     question-ELO is never nudged here — covered by elo-stress-test.sql).
-- =========================================================

begin;

-- ── fixtures: 20 users, 9 guaranteed-active questions ────────────────────────
create temp table _qt (k text primary key, v text);
create temp table _qu (i int primary key, uid uuid not null, elo0 int not null);
create temp table _qm (seq int primary key, mid uuid not null);

do $$
declare
  v_uid uuid;
  v_elo int;
begin
  for i in 1..20 loop
    v_uid := gen_random_uuid();
    v_elo := case when i = 19 then 3000
                  when i = 20 then 5000
                  else 1000 + (i % 5) * 10 end;   -- 18 users within 40 ELO
    insert into auth.users (id, aud, role, email)
    values (v_uid, 'authenticated', 'authenticated', 'qstress-' || i || '@test.local');
    -- direct auth.users insert may or may not fire handle_new_user; ensure profiles
    insert into profiles (id, username, display_name)
    values (v_uid, 'qstress_' || i, 'Q' || i)
    on conflict (id) do nothing;
    update profiles set elo = v_elo where id = v_uid;
    insert into _qu values (i, v_uid, v_elo);
  end loop;

  -- guarantee >=3 active questions per section so the adaptive picker always
  -- has a pool (the driver below is generic — it doesn't care WHICH questions
  -- the picker chose, ours or pre-existing ones)
  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select (array['VARC','VARC','VARC','DILR','DILR','DILR','QUANT','QUANT','QUANT'])[g]::cat_section,
         3, 'qstress q' || g, '["w","x","y","z"]'::jsonb, (g % 4)::smallint, 'because', 1200
  from generate_series(1, 9) g;

  insert into _qt values ('elo_sum_before',
    (select sum(p.elo)::text from profiles p join _qu u on u.uid = p.id));
  raise notice 'fixtures: 20 users seeded, elo sum %', (select v from _qt where k = 'elo_sum_before');
end $$;

-- ── 1. join storm -> pairing invariants ──────────────────────────────────────
do $$
declare
  u record; n int;
begin
  -- u1 joins twice: the partial-unique upsert must leave exactly one waiting row
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select uid from _qu where i = 1), 'role', 'authenticated')::text, true);
  perform join_queue();
  perform join_queue();
  select count(*) into n from matchmaking_queue
  where user_id = (select uid from _qu where i = 1);
  if n <> 1 then raise exception '1: double join left % queue rows (want 1)', n; end if;

  for u in select i, uid from _qu where i >= 2 order by i loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
    perform join_queue();
  end loop;
  perform set_config('request.jwt.claims', null, true);
end $$;

do $$
declare
  n int; bad int;
begin
  insert into _qm (seq, mid)
  select row_number() over (order by m.created_at, m.id), m.id
  from matches m
  where m.player_a in (select uid from _qu) and m.player_b in (select uid from _qu);

  select count(*) into n from _qm;
  if n <> 9 then raise exception '1: expected 9 matches from 18 in-band users, got %', n; end if;

  -- no self-pairs (also a table CHECK, but assert the pairing logic anyway)
  if exists (select 1 from matches m join _qm on _qm.mid = m.id where m.player_a = m.player_b) then
    raise exception '1: self-paired match found';
  end if;

  -- no double-pairs: nobody is in two live matches
  select count(*) into bad from (
    select p from (
      select player_a as p from matches m join _qm on _qm.mid = m.id
      union all
      select player_b from matches m join _qm on _qm.mid = m.id
    ) s group by p having count(*) > 1
  ) d;
  if bad > 0 then raise exception '1: % user(s) paired into two live matches', bad; end if;

  -- exactly one queue row per user; 18 matched + 2 waiting; every matched row
  -- points at a real match that user participates in (no orphans)
  select count(*) into bad from _qu u
  where (select count(*) from matchmaking_queue q where q.user_id = u.uid) <> 1;
  if bad > 0 then raise exception '1: % user(s) without exactly one queue row', bad; end if;

  select count(*) into n from matchmaking_queue q join _qu u on u.uid = q.user_id
  where q.status = 'matched';
  if n <> 18 then raise exception '1: expected 18 matched queue rows, got %', n; end if;

  select count(*) into bad from matchmaking_queue q join _qu u on u.uid = q.user_id
  where q.status = 'matched'
    and (q.match_id is null or not exists (
      select 1 from matches m
      where m.id = q.match_id and q.user_id in (m.player_a, m.player_b)));
  if bad > 0 then raise exception '1: % orphaned matched queue row(s)', bad; end if;

  -- outliers (u19 elo 3000, u20 elo 5000) must still be waiting: at 0s wait
  -- the band is 100 and they are >100 from everyone (band enforced negatively)
  select count(*) into n from matchmaking_queue q
  where q.status = 'waiting' and q.user_id in (select uid from _qu where i in (19, 20));
  if n <> 2 then raise exception '1: outliers not left waiting (found % waiting)', n; end if;

  -- band respected positively at pairing time: frozen now() => wait 0s => 100
  select count(*) into bad from matches m join _qm on _qm.mid = m.id
  where abs(m.elo_a_before - m.elo_b_before) > 100;
  if bad > 0 then raise exception '1: % match(es) paired outside the 100-ELO band', bad; end if;

  -- matches frozen correctly at creation
  select count(*) into bad from matches m join _qm on _qm.mid = m.id
  where m.status <> 'pending' or not m.is_rated
     or coalesce(array_length(m.question_ids, 1), 0) <> 9;
  if bad > 0 then raise exception '1: % match(es) not pending/rated/9-questions', bad; end if;

  raise notice 'PASS 1: 20-user join storm -> 9 clean pairs, 2 out-of-band waiting, queue accounted';
end $$;

-- ── 2. join_queue lockout while already in a live match ──────────────────────
do $$
declare
  raised boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select uid from _qu where i = 1), 'role', 'authenticated')::text, true);
  begin
    perform join_queue();
  exception when others then
    raised := true;
    if position('already in a live match' in sqlerrm) = 0 then
      raise exception '2: wrong error: %', sqlerrm;
    end if;
  end;
  if not raised then raise exception '2: join_queue ALLOWED while in a pending match'; end if;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 2: join_queue rejected while in a live match';
end $$;

-- ── 3. ghost sweep: stale heartbeat cancelled, fresh row survives ─────────────
do $$
declare
  s queue_status;
begin
  update matchmaking_queue set heartbeat_at = now() - interval '2 minutes'
  where user_id = (select uid from _qu where i = 20) and status = 'waiting';

  perform rematch_waiting();

  select status into s from matchmaking_queue
  where user_id = (select uid from _qu where i = 20);
  if s <> 'cancelled' then raise exception '3: stale-heartbeat row not swept (status %)', s; end if;
  select status into s from matchmaking_queue
  where user_id = (select uid from _qu where i = 19);
  if s <> 'waiting' then raise exception '3: fresh waiting row was disturbed (status %)', s; end if;
  raise notice 'PASS 3: rematch_waiting sweeps stale heartbeats, keeps live waiters';
end $$;

-- ── 4. start_match: activates once; the second (racing) caller is a no-op ─────
do $$
declare
  mrec record; m matches%rowtype; m1 uuid := (select mid from _qm where seq = 1);
begin
  for mrec in select _qm.mid from _qm order by seq loop
    select * into m from matches where id = mrec.mid;
    perform set_config('request.jwt.claims',
      json_build_object('sub', m.player_a, 'role', 'authenticated')::text, true);
    perform start_match(mrec.mid);
    select * into m from matches where id = mrec.mid;
    if m.status <> 'active' or m.started_at is null or m.question_started_at is null
       or m.current_index <> 0 then
      raise exception '4: start_match left match % in status % (started_at %, qsa %, idx %)',
        mrec.mid, m.status, m.started_at, m.question_started_at, m.current_index;
    end if;
  end loop;

  -- idempotency: backdate started_at, then the OTHER player fires start_match
  -- (both fire on presence-both in the client) — it must not re-stamp anything
  update matches set started_at = now() - interval '1 second' where id = m1;
  select * into m from matches where id = m1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', m.player_b, 'role', 'authenticated')::text, true);
  perform start_match(m1);
  select * into m from matches where id = m1;
  if m.started_at <> now() - interval '1 second' then
    raise exception '4: second start_match re-stamped started_at (double-start guard broken)';
  end if;
  if m.status <> 'active' or m.current_index <> 0 then
    raise exception '4: second start_match disturbed match state';
  end if;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 4: start_match activates once; racing second call is a no-op';
end $$;

-- ── 5. first-question load renders for BOTH players of every match ───────────
do $$
declare
  mrec record; m matches%rowtype; pid uuid;
  opts jsonb; sat timestamptz; nrows int;
begin
  for mrec in select _qm.mid from _qm order by seq loop
    select * into m from matches where id = mrec.mid;
    foreach pid in array array[m.player_a, m.player_b] loop
      perform set_config('request.jwt.claims',
        json_build_object('sub', pid, 'role', 'authenticated')::text, true);
      select count(*) into nrows from get_match_question(mrec.mid, 0::smallint);
      if nrows <> 1 then
        raise exception '5: get_match_question(0) returned % rows for match % player %', nrows, mrec.mid, pid;
      end if;
      select g.options, g.started_at into opts, sat
      from get_match_question(mrec.mid, 0::smallint) g;
      if opts is null or jsonb_array_length(opts) < 2 or sat is null then
        raise exception '5: unrenderable first question for match % player % (opts %, started_at %)',
          mrec.mid, pid, opts, sat;
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 5: first question loads for both players of all 9 matches';
end $$;

-- ── 6. cron path: NULL-time skip rows + advance ───────────────────────────────
do $$
declare
  m1 uuid := (select mid from _qm where seq = 1);
  m matches%rowtype; n int;
begin
  update matches set question_started_at = now() - interval '200 seconds' where id = m1;
  perform advance_timed_out();   -- sweeps ALL active matches; only m1 is past deadline here

  select * into m from matches where id = m1;
  if m.current_index <> 1 then
    raise exception '6: cron did not advance m1 (current_index %)', m.current_index;
  end if;
  if m.question_started_at < now() then
    raise exception '6: cron did not restart the question timer';
  end if;
  select count(*) into n from match_answers
  where match_id = m1 and question_index = 0
    and selected_index is null and time_taken_ms is null;
  if n <> 2 then
    raise exception '6: expected 2 cron NULL-time skip rows on m1/q0, got %', n;
  end if;
  raise notice 'PASS 6: advance_timed_out inserts NULL-time skips and advances';
end $$;

-- ── 7. drive all matches to completion through the real RPCs ─────────────────
-- player_a answers every question CORRECTLY via the display index that
-- option_perm maps back to canonical (exercising the shuffle contract with
-- whatever questions the adaptive picker chose); player_b answers wrong,
-- except one explicit client skip (m2/q0) proving client skips record a time.
do $$
declare
  mrec record; m matches%rowtype; q questions%rowtype;
  m2 uuid := (select mid from _qm where seq = 2);
  perm int[]; disp int; wrong_disp int; n int; step int; ok boolean;
begin
  for mrec in select _qm.mid from _qm order by seq loop
    for step in 1..9 loop
      select * into m from matches where id = mrec.mid;
      exit when m.status <> 'active';
      select * into q from questions where id = m.question_ids[m.current_index + 1];
      n := jsonb_array_length(q.options);

      -- player A: correct
      perm := option_perm(m.id, m.player_a, m.current_index, n);
      select ord - 1 into disp from unnest(perm) with ordinality t(p, ord)
      where p = q.correct_index;
      perform set_config('request.jwt.claims',
        json_build_object('sub', m.player_a, 'role', 'authenticated')::text, true);
      perform submit_answer(m.id, m.current_index::smallint, disp::smallint);
      select a.is_correct into ok from match_answers a
      where a.match_id = m.id and a.user_id = m.player_a and a.question_index = m.current_index;
      if not ok then
        raise exception '7: A submitted displayed-correct on match % q%, scored WRONG (shuffle desync)',
          m.id, m.current_index;
      end if;

      -- player B: wrong (or explicit skip on m2/q0)
      perform set_config('request.jwt.claims',
        json_build_object('sub', m.player_b, 'role', 'authenticated')::text, true);
      if m.id = m2 and m.current_index = 0 then
        perform submit_answer(m.id, m.current_index::smallint, null::smallint);
      else
        perm := option_perm(m.id, m.player_b, m.current_index, n);
        select ord - 1 into wrong_disp from unnest(perm) with ordinality t(p, ord)
        where p <> q.correct_index limit 1;
        perform submit_answer(m.id, m.current_index::smallint, wrong_disp::smallint);
      end if;
    end loop;

    select * into m from matches where id = mrec.mid;
    if m.status <> 'completed' then
      raise exception '7: match % did not finalize (status %, idx %)', mrec.mid, m.status, m.current_index;
    end if;
  end loop;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 7: all 9 matches driven to completion via submit_answer/maybe_advance/finalize';
end $$;

-- ── 8. post-hoc accounting ────────────────────────────────────────────────────
do $$
declare
  bad int; n int; s_before bigint; s_after bigint;
  m1 uuid := (select mid from _qm where seq = 1);
  m2 uuid := (select mid from _qm where seq = 2);
  r record;
begin
  -- 8a: every match completed with player_a (the all-correct player) winning
  select count(*) into bad from matches m join _qm on _qm.mid = m.id
  where m.status <> 'completed' or m.winner_id is distinct from m.player_a
     or m.ended_at is null;
  if bad > 0 then raise exception '8a: % match(es) with wrong terminal state/winner', bad; end if;

  -- 8b: exact zero-sum player ELO across all rated finalizations.
  -- All 20 users' elos sum to the fixture baseline: nobody is near the 100
  -- floor (elos ~1000, deltas <=~28), so no clamp slack — assert EXACT.
  s_before := (select v::bigint from _qt where k = 'elo_sum_before');
  select sum(p.elo) into s_after from profiles p join _qu u on u.uid = p.id;
  if s_after <> s_before then
    raise exception '8b: ELO not zero-sum: sum % -> % (drift %)', s_before, s_after, s_after - s_before;
  end if;

  -- per-match zero-sum with a real transfer
  select count(*) into bad from matches m join _qm on _qm.mid = m.id
  where (m.elo_a_after - m.elo_a_before) + (m.elo_b_after - m.elo_b_before) <> 0
     or (m.elo_a_after - m.elo_a_before) <= 0;
  if bad > 0 then raise exception '8b: % match(es) violate per-match zero-sum / positive winner delta', bad; end if;

  -- 8c: rating_history — exactly 2 rows per match, deltas sum to 0, and each
  -- profile's final elo equals its seed plus the sum of its history deltas
  select count(*) into n from rating_history rh join _qm on _qm.mid = rh.match_id;
  if n <> 18 then raise exception '8c: expected 18 rating_history rows, got %', n; end if;
  if (select sum(delta) from rating_history rh join _qm on _qm.mid = rh.match_id) <> 0 then
    raise exception '8c: rating_history deltas do not sum to zero';
  end if;
  select count(*) into bad
  from _qu u join profiles p on p.id = u.uid
  where p.elo <> u.elo0 + coalesce(
    (select sum(rh.delta) from rating_history rh
     join _qm on _qm.mid = rh.match_id where rh.user_id = u.uid), 0);
  if bad > 0 then raise exception '8c: % profile(s) whose elo != seed + sum(history deltas)', bad; end if;

  -- 8d: match_answers accounting. 18 rows per match (9 q x 2 players), the
  -- unique (match_id,user_id,question_index) key holds, NULL time_taken_ms
  -- appears ONLY on the two cron rows (m1/q0) — every client submission,
  -- including the explicit skip, recorded a time.
  select count(*) into bad from _qm
  where (select count(*) from match_answers a where a.match_id = _qm.mid) <> 18;
  if bad > 0 then raise exception '8d: % match(es) without exactly 18 answer rows', bad; end if;

  select count(*) - count(distinct (a.match_id, a.user_id, a.question_index)) into bad
  from match_answers a join _qm on _qm.mid = a.match_id;
  if bad <> 0 then raise exception '8d: duplicate (match,user,question) answer rows: %', bad; end if;

  select count(*) into n from match_answers a join _qm on _qm.mid = a.match_id
  where a.time_taken_ms is null;
  if n <> 2 then raise exception '8d: % NULL-time rows (want exactly the 2 cron rows)', n; end if;
  if exists (select 1 from match_answers a where a.match_id <> m1 and a.time_taken_ms is null
             and a.match_id in (select _qm.mid from _qm)) then
    raise exception '8d: NULL-time row outside the cron-advanced match';
  end if;
  select * into r from match_answers a
  where a.match_id = m2 and a.question_index = 0
    and a.user_id = (select player_b from matches where id = m2);
  if r.selected_index is not null or r.time_taken_ms is null then
    raise exception '8d: explicit client skip stored (selected %, time %) — want (NULL, NOT NULL)',
      r.selected_index, r.time_taken_ms;
  end if;

  -- 8e: queue table fully accounted at the end: 18 matched rows pointing at
  -- now-completed matches, u19 still waiting, u20 cancelled — no orphans
  select count(*) into bad from matchmaking_queue q join _qu u on u.uid = q.user_id
  where q.status = 'matched'
    and not exists (select 1 from matches m where m.id = q.match_id
                    and m.status = 'completed' and q.user_id in (m.player_a, m.player_b));
  if bad > 0 then raise exception '8e: % matched queue row(s) not pointing at a completed match', bad; end if;
  if (select status from matchmaking_queue where user_id = (select uid from _qu where i = 19)) <> 'waiting'
     or (select status from matchmaking_queue where user_id = (select uid from _qu where i = 20)) <> 'cancelled' then
    raise exception '8e: outlier queue rows in unexpected state';
  end if;

  -- 8f: profile counters add up: 9 wins, 9 losses, 18 matches played
  if (select sum(p.wins) from profiles p join _qu u on u.uid = p.id) <> 9
     or (select sum(p.losses) from profiles p join _qu u on u.uid = p.id) <> 9
     or (select sum(p.draws) from profiles p join _qu u on u.uid = p.id) <> 0
     or (select sum(p.matches_played) from profiles p join _qu u on u.uid = p.id) <> 18 then
    raise exception '8f: W/L/D/played counters do not add up (want 9/9/0/18)';
  end if;

  raise notice 'PASS 8: zero-sum ELO, history, answer uniqueness, cron-NULL semantics, queue + counters accounted';
end $$;

rollback;
