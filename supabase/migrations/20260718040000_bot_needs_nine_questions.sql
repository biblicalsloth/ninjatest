-- match_with_bot: adaptive fill + 9-question guard (the bot twin of the
-- 20260718000000 try_match_internal fix).
--
-- match_with_bot built q_ids as VARC(3) || DILR(3) || QUANT(3) and rejected
-- ONLY when the total was empty. A section with < 3 pickable active questions
-- makes pick_section_question_ids return NULL (coalesced to '{}'), so the bot
-- match silently truncated to < 9 — and unlike try_match_internal's clean
-- "stay waiting", this then CORRUPTS mid-play: matches.current_index runs past
-- question_ids and get_match_question reads question_ids[index+1] = NULL. Live
-- proof: any deployment with an empty/under-filled VARC or DILR section (the
-- local dev DB has zero VARC) produced a 6-question bot match with no error.
--
-- Fix mirrors try_match_internal exactly: a section with < 3 active questions
-- contributes 0 slots that roll into QUANT (which serves any count), and the
-- match is refused unless it holds exactly 9. On a content gap the caller
-- raises 'no questions available' — the client already toasts and keeps the
-- user in queue (lobby-client.tsx / queue/page.tsx). Happy path (all sections
-- >= 3) is unchanged: still 3-3-3.
--
-- HUMAN only in prefer-unseen (array[uid]) — preserved from the latest def
-- (20260716220817): the bot answers every match, so folding its history into
-- the seen set collapses the pool for everyone.
--
-- Signature unchanged (no args) so create-or-replace does not fork an overload
-- (migration discipline #6). Starts from the latest def
-- (20260716220817_prefer_unseen_questions.sql), discipline #1. search_path
-- pinned inline, grants re-applied (discipline #2).
-- Guarded by scripts/ninja-guard-test.sql — re-run after applying.

create or replace function match_with_bot()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid          uuid := (select auth.uid());
  bot_id       uuid := '00000000-0000-0000-0000-00000000b071';
  me           matchmaking_queue%rowtype;
  my_elo       int;
  q_ids        uuid[];
  n_varc       int;
  n_dilr       int;
  new_match_id uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('match_with_bot', 5, 60);

  select * into me from matchmaking_queue
  where user_id = uid and status = 'waiting'
  order by enqueued_at desc limit 1
  for update;
  if not found then raise exception 'not in queue'; end if;
  if me.enqueued_at > now() - interval '15 seconds' then
    raise exception 'bot not available yet';
  end if;

  select elo into my_elo from profiles where id = uid;

  -- Adaptive fill: a section with < 3 active questions contributes 0 slots,
  -- which roll into QUANT. The HUMAN only in prefer-unseen (array[uid]).
  n_varc := case when (select count(*) from questions where section = 'VARC' and is_active) >= 3 then 3 else 0 end;
  n_dilr := case when (select count(*) from questions where section = 'DILR' and is_active) >= 3 then 3 else 0 end;

  q_ids := case when n_varc = 3 then coalesce(pick_section_question_ids('VARC', my_elo, array[uid]), '{}') else '{}' end
        || case when n_dilr = 3 then coalesce(pick_section_question_ids('DILR', my_elo, array[uid]), '{}') else '{}' end
        || coalesce(pick_quant_question_ids(my_elo, 9 - n_varc - n_dilr, array[uid]), '{}');

  -- Never create a truncated match — a < 9 question_ids array corrupts mid-play.
  if coalesce(array_length(q_ids, 1), 0) <> 9 then
    raise exception 'no questions available';
  end if;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, started_at, question_started_at)
  values (uid, bot_id, 'active', false, q_ids,
          my_elo, my_elo,
          now(), now() + interval '3 seconds')
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id = me.id;

  return new_match_id;
end; $$;

revoke all on function match_with_bot() from public, anon;
grant execute on function match_with_bot() to authenticated, service_role;
