-- =========================================================
-- FIX: ELO band expansion in matchmaking
--
-- Problems fixed:
-- 1. Band computed only from joiner's elapsed time.
--    If A waited 60s (band 1000) and B just joined (band 100),
--    B's try_match used band 100 and missed A.
--    Fix: GREATEST(my_band, opp_band) — either player's wider band wins.
-- 2. try_match only ran on join_queue. Two long-waiting players never got
--    rematched unless someone new joined.
--    Fix: rematch_waiting() pg_cron sweep every minute.
-- =========================================================

-- Internal parameterised version used by both join_queue and cron sweep.
-- Not callable by clients (REVOKE below).
create or replace function try_match_internal(p_user_id uuid)
returns uuid language plpgsql security definer as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  select * into me
  from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  my_band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  -- Match if either player's band covers the ELO gap.
  -- Lets a long-waiting player match a fresh joiner even when the
  -- joiner's own band is still narrow.
  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  select array_agg(id) into q_ids from (
    (select id from questions where section = 'VARC'  and is_active order by random() limit 3)
    union all
    (select id from questions where section = 'DILR'  and is_active order by random() limit 3)
    union all
    (select id from questions where section = 'QUANT' and is_active order by random() limit 3)
  ) s;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids, me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

-- Public try_match() — still called by join_queue, uses auth.uid().
create or replace function try_match()
returns uuid language plpgsql security definer as $$
begin
  return try_match_internal(auth.uid());
end;
$$;

-- Sweep: attempt to match every waiting player.
-- FOR UPDATE SKIP LOCKED inside try_match_internal prevents double-matching.
create or replace function rematch_waiting()
returns void language plpgsql security definer as $$
declare
  rec record;
begin
  for rec in
    select user_id
    from matchmaking_queue
    where status = 'waiting'
    order by enqueued_at
  loop
    perform try_match_internal(rec.user_id);
  end loop;
end;
$$;

-- Lock down: clients must not call these directly.
revoke execute on function try_match_internal(uuid) from public, anon, authenticated;
revoke execute on function rematch_waiting()         from public, anon, authenticated;

-- Schedule sweep every minute (pg_cron minimum granularity).
-- Idempotent: unschedule first if already exists.
select cron.unschedule('rematch-waiting')
where exists (select 1 from cron.job where jobname = 'rematch-waiting');
select cron.schedule('rematch-waiting', '* * * * *', 'select rematch_waiting()');