-- Self-service account deletion.
--
-- App code cannot delete auth.users from the client and must not use service_role, so this
-- SECURITY DEFINER RPC (owned by postgres) deletes the CALLER's own account only.
--
-- FK audit (2026-07-19): deleting auth.users cascades to profiles, but profiles has many
-- children with ON DELETE NO ACTION that would block that cascade:
--   challenges(host/guest/target), direct_messages(sender/recipient),
--   friendships(user_a/user_b/requested_by), match_answers(user_id),
--   matches(player_a/player_b/winner_id), matchmaking_queue(user_id),
--   rating_history(user_id), season_results(user_id).
-- CASCADE children (match_events, practice_sessions -> practice_answers) and the ninja_*
-- tables (FK auth.users ON DELETE CASCADE) clean themselves. matches deletion is itself
-- blocked by challenges.match_id / matchmaking_queue.match_id (NO ACTION); its CASCADE
-- children (match_answers, match_events, ninja_debriefs, ninja_responses) and SET NULL
-- children (rating_history.match_id, ninja_coach_messages.match_id) are fine.
--
-- So clear the NO ACTION blockers in FK-safe order, then delete auth.users last.
-- Deleting the caller's matches also removes those shared match rows (and the opponent's
-- answers via cascade) from the opponent's history — accepted for MVP account deletion;
-- an orphaned match with a deleted player is worse.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- challenges / matchmaking_queue: block both matches deletion (match_id NO ACTION) and
  -- the profile delete (their *_id NO ACTION). Cover the user's own rows AND any pointing
  -- at the user's matches (possibly from the opponent).
  delete from public.challenges
    where host_id = uid or guest_id = uid or target_id = uid
       or match_id in (select id from public.matches where player_a = uid or player_b = uid);

  delete from public.matchmaking_queue
    where user_id = uid
       or match_id in (select id from public.matches where player_a = uid or player_b = uid);

  -- the user's own answers (user_id NO ACTION -> profiles); opponent answers in the user's
  -- matches cascade when the match is deleted below.
  delete from public.match_answers where user_id = uid;

  -- the user's matches (player_a/player_b/winner_id NO ACTION -> profiles).
  delete from public.matches where player_a = uid or player_b = uid;

  -- remaining profile-referencing blockers
  delete from public.direct_messages where sender_id = uid or recipient_id = uid;
  delete from public.friendships where user_a = uid or user_b = uid or requested_by = uid;
  delete from public.rating_history where user_id = uid;
  delete from public.season_results where user_id = uid;

  -- the user's uploaded avatar object(s)
  delete from storage.objects
    where bucket_id = 'avatars' and (storage.foldername(name))[1] = uid::text;

  -- finally the auth user; cascades profiles, ninja_* (auth.users), match_events(user_id),
  -- practice_sessions (+ practice_answers, ninja_responses.practice_session_id).
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
