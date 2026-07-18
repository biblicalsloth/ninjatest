-- A mixed match is assembled as VARC(3) || DILR(3) || QUANT(3). A section with
-- no ACTIVE content contributes 0 slots — pick_section_question_ids returns
-- NULL, coalesced to '{}' — so the match silently truncates to fewer than 9
-- questions. `matches.current_index` then runs past `question_ids`, and the
-- match corrupts mid-play (get_match_question reads question_ids[index+1] = NULL).
--
-- This is live on Quant-only content (passages empty + no active VARC/DILR):
-- try_match_internal would create a 3-question match with no error. Guard it —
-- never create a match that can't hold 9. On a content gap both players simply
-- stay 'waiting' (they re-attempt every heartbeat/cron sweep). Non-throwing so
-- it doesn't abort join_queue, queue_heartbeat, or the rematch_waiting cron
-- loop that all call this. Happy path is unchanged: a full bank yields 9 and
-- the guard is a no-op.
--
-- Starts from the latest def (20260716220817_prefer_unseen_questions.sql) per
-- migration discipline #1. Guarded by scripts/elo-stress-test.sql §16.
create or replace function try_match_internal(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
  target       integer;
  players      uuid[];
  n_varc       integer;
  n_dilr       integer;
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
    and heartbeat_at > now() - interval '90 seconds'
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  target  := ((me.elo + opp.elo) / 2)::int;
  -- Both players: a question either has seen is a repeat for that one and an
  -- asymmetric advantage over the other, which is the whole point of the rule.
  players := array[me.user_id, opp.user_id];

  -- Adaptive fill: a section with < 3 active questions contributes nothing and
  -- its 3 slots roll into QUANT (which can serve any count). Today VARC/DILR are
  -- empty, so this is 9 QUANT; once they have content it rebalances to 3-3-3
  -- with no code change. QUANT always backfills so the array reaches 9.
  n_varc := case when (select count(*) from questions where section = 'VARC' and is_active) >= 3 then 3 else 0 end;
  n_dilr := case when (select count(*) from questions where section = 'DILR' and is_active) >= 3 then 3 else 0 end;

  q_ids := case when n_varc = 3 then coalesce(pick_section_question_ids('VARC', target, players), '{}') else '{}' end
        || case when n_dilr = 3 then coalesce(pick_section_question_ids('DILR', target, players), '{}') else '{}' end
        || coalesce(pick_quant_question_ids(target, 9 - n_varc - n_dilr, players), '{}');

  -- Never create a truncated match. A section with no active content drops
  -- slots; if we can't fill 9, don't pair — leave both waiting.
  if coalesce(array_length(q_ids, 1), 0) <> 9 then
    return null;
  end if;

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

revoke all on function try_match_internal(uuid) from public, anon, authenticated;
grant execute on function try_match_internal(uuid) to service_role;
