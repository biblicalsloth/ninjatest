-- match_with_bot: callable from the lobby (no queue row required).
--
-- The lobby's "Vs Ninja Bot" card (lobby-client.tsx) calls match_with_bot
-- directly, but the RPC demanded a 'waiting' matchmaking_queue row enqueued
-- >= 15s ago — both only true on the /queue fallback path. From the lobby it
-- raised 'not in queue' on every click, which the client surfaces as
-- "Bot unavailable right now". The button promised "Instant match" and could
-- never succeed.
--
-- Fix, starting from the latest def (20260718040000, discipline #1):
--   1. Queue row is now OPTIONAL. If a 'waiting' row exists (queue fallback
--      path, or a ghost row from an abandoned queue visit) it is consumed and
--      marked 'matched' exactly as before; if none, the match is created
--      directly — the caller routes itself on the returned uuid, nothing
--      reads the queue for bot matches.
--   2. The 15s enqueued-age check is dropped. It only ever guarded the queue
--      path, where the client already hides the bot button until 20s elapsed
--      (queue/page.tsx), and check_rate_limit(5/60s) bounds scripted abuse.
--      An instant lobby path is the product intent.
--   3. Live-match guard added (mirrors join_queue, 20260714140000): the lobby
--      path no longer passes through join_queue, so without this a player
--      with an active/pending match could open a second, concurrent match.
--
-- Signature unchanged (no args) — no overload fork (discipline #6).
-- search_path pinned inline, grants re-applied (discipline #2).
-- Adaptive fill + exactly-9 guard from 20260718040000 preserved verbatim.

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

  -- The lobby path skips join_queue, so its live-match guard must live here too.
  if exists (
    select 1 from matches
    where (player_a = uid or player_b = uid)
      and status in ('active', 'pending')
  ) then
    raise exception 'already in a live match';
  end if;

  -- Optional: consume the caller's waiting queue row if one exists (queue
  -- fallback path / ghost row). Absent row = lobby direct path, not an error.
  select * into me from matchmaking_queue
  where user_id = uid and status = 'waiting'
  order by enqueued_at desc limit 1
  for update;

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

  if me.id is not null then
    update matchmaking_queue
    set status = 'matched', match_id = new_match_id
    where id = me.id;
  end if;

  return new_match_id;
end; $$;

revoke all on function match_with_bot() from public, anon;
grant execute on function match_with_bot() to authenticated, service_role;
