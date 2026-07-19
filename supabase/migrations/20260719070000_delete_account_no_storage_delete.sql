-- delete_account: drop the direct storage.objects delete.
--
-- 20260719060000 tried to delete the caller's avatar object inside the RPC, but Supabase
-- guards storage tables with a storage.protect_delete() trigger that RAISES on any direct
-- DELETE ("Use the Storage API instead"). So the avatar cleanup can't happen in SQL — it
-- moves to the client, which calls the Storage API (storage.from('avatars').remove([...]))
-- under the avatars_user_delete RLS policy before invoking this RPC. Everything else is
-- unchanged; the FK-safe deletion order was verified against a synthetic shared match.

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

  delete from public.challenges
    where host_id = uid or guest_id = uid or target_id = uid
       or match_id in (select id from public.matches where player_a = uid or player_b = uid);

  delete from public.matchmaking_queue
    where user_id = uid
       or match_id in (select id from public.matches where player_a = uid or player_b = uid);

  delete from public.match_answers where user_id = uid;

  delete from public.matches where player_a = uid or player_b = uid;

  delete from public.direct_messages where sender_id = uid or recipient_id = uid;
  delete from public.friendships where user_a = uid or user_b = uid or requested_by = uid;
  delete from public.rating_history where user_id = uid;
  delete from public.season_results where user_id = uid;

  -- avatar object(s) are removed client-side via the Storage API before this call.

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
