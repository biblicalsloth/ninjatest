-- delete_account: erase EVERY trace of the user.
--
-- Two tables held the caller's data but were not covered before:
--   * rpc_rate_limit (user_id) — has NO foreign key, so it is never cascaded; its rows survived.
--   * waitlist (email, no user_id, no FK) — the caller's signup + survey answers survived.
-- Both are now deleted. waitlist keys on email, so it must be removed while auth.users still
-- exists (to read the caller's email). Everything else is unchanged and FK-safe-verified.

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
  delete from public.rpc_rate_limit where user_id = uid;

  -- keyed by email, no FK — remove while auth.users still exists.
  delete from public.waitlist
    where lower(email) = (select lower(email) from auth.users where id = uid);

  -- avatar object(s) are removed client-side via the Storage API before this call
  -- (storage.protect_delete() blocks any direct DELETE on storage tables).

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
