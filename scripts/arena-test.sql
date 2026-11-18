-- =========================================================
-- Arena invariant harness (20261121000000_arena). Assert-based; raises on any
-- violation, NOTICEs on success. One transaction, ROLLED BACK. Inserts
-- auth.users — run on local / a branch, never prod:
--
--   docker exec -i supabase_db_ninjatest psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < scripts/arena-test.sql
--
-- Needs >= 9 active questions in the bank (local seed has them).
-- now() is frozen in-txn, so clocks are moved by backdating columns.
--   1. no pop below 8 before 60s; pop at exactly 8
--   2. failed ready-check: decline cancels, accepters requeued with original
--      enqueued_at, decliner dropped + cooldown
--   3. flex pop: 4+ after the oldest waited 60s
--   4. active: queue cleared, cross-mode guards (join_queue, arena_busy)
--   5. play: shuffle-consistent scoring, scores hidden mid-game, vanished seat
--      drained by any participant's poll
--   6. finalize: ranking, exact zero-sum, 100 floor, history rows tagged
-- =========================================================

begin;

create temp table _t (k text primary key, v text);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- fixtures: 8 users, one ELO band, plus u9 as a late joiner
do $$
declare u uuid;
begin
  for i in 1..9 loop
    u := gen_random_uuid();
    insert into auth.users (id, aud, role, email)
    values (u, 'authenticated', 'authenticated', 'arena-' || i || '@test.local');
    insert into profiles (id, username, display_name)
    values (u, 'arena_t' || i, 'A' || i) on conflict (id) do nothing;
    update profiles set elo = 1000 + i * 10 where id = u;
    insert into _t values ('u' || i, u::text);
  end loop;
end $$;

create or replace function pg_temp.u(i int) returns uuid language sql as $$
  select v::uuid from _t where k = 'u' || i;
$$;

-- ── 1. no pop below 8 before 60s; pop at 8 ──────────────────────────────────
do $$
declare aid uuid; n int;
begin
  for i in 1..7 loop
    perform pg_temp.as_user(pg_temp.u(i));
    perform arena_join();
  end loop;
  if exists (select 1 from arenas a join arena_players ap on ap.arena_id = a.id where ap.user_id = pg_temp.u(1)) then
    raise exception '1: popped with 7 before 60s';
  end if;

  perform pg_temp.as_user(pg_temp.u(8));
  perform arena_join();
  select ap.arena_id into aid from arena_players ap where ap.user_id = pg_temp.u(8);
  if aid is null then raise exception '1: did not pop at 8'; end if;
  select count(*) into n from arena_players where arena_id = aid;
  if n <> 8 then raise exception '1: expected 8 seats, got %', n; end if;
  if (select count(*) from arena_queue where arena_id = aid and status = 'forming') <> 8 then
    raise exception '1: queue rows not moved to forming';
  end if;
  if (select status from arenas where id = aid) <> 'forming' then raise exception '1: arena not forming'; end if;
  insert into _t values ('a1', aid::text);
  raise notice 'PASS 1: no pop at 7 (<60s), pop at 8';
end $$;

-- ── 2. failed ready-check ───────────────────────────────────────────────────
do $$
declare aid uuid := (select v::uuid from _t where k = 'a1'); t0 timestamptz;
begin
  update arena_queue set enqueued_at = now() - interval '20 seconds' where user_id = pg_temp.u(1);
  select enqueued_at into t0 from arena_queue where user_id = pg_temp.u(1);

  for i in 1..7 loop
    perform pg_temp.as_user(pg_temp.u(i));
    perform arena_accept(aid);
  end loop;
  if (select status from arenas where id = aid) <> 'forming' then raise exception '2: went active without seat 8'; end if;

  perform pg_temp.as_user(pg_temp.u(8));
  perform arena_decline(aid);
  if (select status from arenas where id = aid) <> 'cancelled' then raise exception '2: decline did not cancel'; end if;
  if (select count(*) from arena_queue where status = 'waiting' and user_id in (select pg_temp.u(g) from generate_series(1,7) g)) <> 7 then
    raise exception '2: accepters not requeued';
  end if;
  if (select enqueued_at from arena_queue where user_id = pg_temp.u(1)) <> t0 then
    raise exception '2: accepter lost queue priority';
  end if;
  if exists (select 1 from arena_queue where user_id = pg_temp.u(8)) then raise exception '2: decliner still queued'; end if;

  begin
    perform arena_join();  -- still u8
    raise exception '2: decliner rejoined inside cooldown';
  exception when others then
    if sqlerrm not like 'arena cooldown%' then raise; end if;
  end;
  raise notice 'PASS 2: decline cancels, accepters keep priority, decliner cooled down';
end $$;

-- ── 3. flex pop at 7 after 60s ──────────────────────────────────────────────
do $$
declare aid uuid; n int;
begin
  perform pg_temp.as_user(pg_temp.u(2));
  perform arena_heartbeat();
  if exists (select 1 from arenas a join arena_players ap on ap.arena_id = a.id
             where ap.user_id = pg_temp.u(2) and a.status = 'forming') then
    raise exception '3: popped 7 before the oldest waited 60s';
  end if;

  update arena_queue set enqueued_at = now() - interval '61 seconds' where user_id = pg_temp.u(1);
  perform arena_heartbeat();
  select a.id into aid from arenas a join arena_players ap on ap.arena_id = a.id
  where ap.user_id = pg_temp.u(2) and a.status = 'forming';
  if aid is null then raise exception '3: no flex pop after 60s'; end if;
  select count(*) into n from arena_players where arena_id = aid;
  if n <> 7 then raise exception '3: expected 7 seats, got %', n; end if;
  insert into _t values ('a2', aid::text);
  raise notice 'PASS 3: flex pop with 7 after 60s';
end $$;

-- ── 4. all accept → active; cross-mode guards ───────────────────────────────
do $$
declare aid uuid := (select v::uuid from _t where k = 'a2');
begin
  for i in 1..7 loop
    perform pg_temp.as_user(pg_temp.u(i));
    perform arena_accept(aid);
  end loop;
  if (select status from arenas where id = aid) <> 'active' then raise exception '4: not active after all accepted'; end if;
  if exists (select 1 from arena_queue where arena_id = aid) then raise exception '4: queue rows left behind'; end if;
  if exists (select 1 from arena_players where arena_id = aid and q_started is null) then raise exception '4: clock not started'; end if;

  perform pg_temp.as_user(pg_temp.u(1));
  if not arena_busy() then raise exception '4: arena_busy false for a seat'; end if;
  begin
    perform join_queue();
    raise exception '4: join_queue accepted an arena player';
  exception when others then
    if sqlerrm <> 'already in an arena' then raise; end if;
  end;
  perform pg_temp.as_user(pg_temp.u(9));
  if arena_busy() then raise exception '4: arena_busy true for an outsider'; end if;
  begin
    perform get_arena_state(aid);
    raise exception '4: outsider read arena state';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;
  raise notice 'PASS 4: active, queue cleared, guards hold';
end $$;

-- ── 5. play ─────────────────────────────────────────────────────────────────
-- u1 all correct · u2 correct on 0-4, wrong after · u3 all wrong (MCQ; TITA
-- typed wrong) · u4-u6 skip everything · u7 vanishes (drained).
do $$
declare
  aid uuid := (select v::uuid from _t where k = 'a2');
  ar arenas%rowtype;
  q questions%rowtype;
  cfg section_config%rowtype;
  opts jsonb; disp int; st jsonb; res jsonb; want int; cap int; cap_base int;
begin
  select * into ar from arenas where id = aid;
  for qi in 0..8 loop
    select * into q from questions where id = ar.question_ids[qi + 1];
    select * into cfg from section_config where section = q.section;
    for i in 1..6 loop
      perform pg_temp.as_user(pg_temp.u(i));
      select options into opts from get_arena_question(aid, qi::smallint);
      if i >= 4 then
        perform arena_submit_answer(aid, qi::smallint, null, null);
        continue;
      end if;
      if q.qtype = 'tita' then
        res := arena_submit_answer(aid, qi::smallint, null,
                 case when i = 1 or (i = 2 and qi < 5) then q.answer_value else '-987654' end);
      else
        if i = 1 or (i = 2 and qi < 5) then
          select ord - 1 into disp from jsonb_array_elements(opts) with ordinality e(val, ord)
          where val = q.options -> q.correct_index;
        else
          select ord - 1 into disp from jsonb_array_elements(opts) with ordinality e(val, ord)
          where val <> q.options -> q.correct_index limit 1;
        end if;
        res := arena_submit_answer(aid, qi::smallint, disp::smallint, null);
      end if;

      -- points must equal submit_answer's formula at taken_ms = 0
      cap_base := coalesce(q.duration_ms, cfg.cap_ms);
      cap      := question_cap_ms(ar.question_ids, qi);
      want := cfg.base_points + round(cfg.speed_mult * floor(least(cap, cap_base)::numeric / cfg.grace_block_ms))::int;
      if (res->>'correct')::boolean <> (i = 1 or (i = 2 and qi < 5)) then
        raise exception '5: q% seat % correctness wrong (shuffle desync?)', qi, i;
      end if;
      if not (res->>'correct')::boolean then
        want := case when q.qtype = 'tita' then 0
                     else -round(want::numeric / greatest(jsonb_array_length(q.options) - 1, 1))::int end;
      end if;
      if (res->>'points')::int <> want then
        raise exception '5: q% seat % points % want %', qi, i, res->>'points', want;
      end if;
    end loop;
  end loop;

  -- mid-game: others' scores hidden, own visible
  perform pg_temp.as_user(pg_temp.u(2));
  st := get_arena_state(aid);
  if st->>'status' <> 'active' then raise exception '5: finalized while u7 still owes answers'; end if;
  if exists (select 1 from jsonb_array_elements(st->'players') p
             where not (p->>'me')::boolean and p->'score' <> 'null'::jsonb) then
    raise exception '5: opponent score leaked mid-game';
  end if;

  -- u7 vanished: backdate its clock; any participant's poll drains + finalizes
  update arena_players set q_started = now() - interval '1 hour' where arena_id = aid and user_id = pg_temp.u(7);
  st := get_arena_state(aid);
  if st->>'status' <> 'completed' then raise exception '5: drain did not finalize (status %)', st->>'status'; end if;
  if (select count(*) from arena_answers where arena_id = aid and user_id = pg_temp.u(7) and time_taken_ms is null) <> 9 then
    raise exception '5: vanished seat not drained with cron-null rows';
  end if;
  raise notice 'PASS 5: scoring = submit_answer formula, scores hidden mid-game, vanished seat drained';
end $$;

-- ── 6. finalize ─────────────────────────────────────────────────────────────
do $$
declare aid uuid := (select v::uuid from _t where k = 'a2'); s int; st jsonb;
begin
  if (select rank from arena_players where arena_id = aid and user_id = pg_temp.u(1)) <> 1 then
    raise exception '6: perfect seat not ranked 1';
  end if;
  if (select rank from arena_players where arena_id = aid and user_id = pg_temp.u(2)) <> 2 then
    raise exception '6: seat 2 not ranked 2';
  end if;
  select sum(elo_after - elo_before) into s from arena_players where arena_id = aid;
  if s <> 0 then raise exception '6: not zero-sum (Σ = %)', s; end if;
  if exists (select 1 from arena_players where arena_id = aid and elo_after < 100) then raise exception '6: below floor'; end if;
  if (select elo_after - elo_before from arena_players where arena_id = aid and user_id = pg_temp.u(1)) <= 0 then
    raise exception '6: winner did not gain';
  end if;
  if (select elo_after - elo_before from arena_players where arena_id = aid and user_id = pg_temp.u(3)) >= 0 then
    raise exception '6: all-wrong seat did not lose';
  end if;
  if exists (select 1 from arena_players ap join profiles p on p.id = ap.user_id
             where ap.arena_id = aid and p.elo <> ap.elo_after) then
    raise exception '6: profiles.elo not written';
  end if;
  if (select count(*) from rating_history where arena_id = aid and match_id is null) <> 7 then
    raise exception '6: rating_history rows missing arena_id';
  end if;
  if exists (select 1 from jsonb_array_elements(get_profile('arena_t1')->'curve') c where (c->>'reset')::boolean) then
    raise exception '6: arena row reads as a season reset in get_profile';
  end if;
  if (select matches_played from profiles where id = pg_temp.u(1)) <> 0 then
    raise exception '6: arena touched 1v1 matches_played';
  end if;

  perform pg_temp.as_user(pg_temp.u(5));
  st := get_arena_state(aid);
  if exists (select 1 from jsonb_array_elements(st->'players') p where p->'score' = 'null'::jsonb) then
    raise exception '6: scores still hidden after completion';
  end if;
  if arena_busy() then raise exception '6: still busy after completion'; end if;
  raise notice 'PASS 6: ranked, zero-sum, floor, history tagged, scores revealed';
end $$;

rollback;
