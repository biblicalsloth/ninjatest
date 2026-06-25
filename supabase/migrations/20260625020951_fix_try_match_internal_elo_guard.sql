-- =========================================================
-- Fix: add rated_pair_count_today guard to try_match_internal
--
-- Previous fix added the guard only to try_match() which is
-- called by join_queue. But rematch_waiting() cron calls
-- try_match_internal() directly, bypassing the guard.
-- Fix: inline the guard in try_match_internal so it applies
-- to both join_queue path and cron sweep.
-- =========================================================

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

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
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

-- Also align try_match() to delegate to try_match_internal
-- (removes the now-duplicate inlined logic from the previous migration)
create or replace function try_match()
returns uuid language plpgsql security definer as $$
begin
  return try_match_internal(auth.uid());
end;
$$;
