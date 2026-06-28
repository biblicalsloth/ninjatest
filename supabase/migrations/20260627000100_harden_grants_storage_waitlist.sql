-- Security hardening surfaced by the Supabase advisor after pinning search_path.
-- Three independent fixes:
--   1. Revoke EXECUTE on internal-only SECURITY DEFINER functions from client roles.
--   2. Stop the public `avatars` bucket from being listable; drop duplicate policies.
--   3. Replace the waitlist INSERT policy's `WITH CHECK (true)` with real validation.

-- ---------------------------------------------------------------------------
-- 1. Internal functions must not be callable via /rest/v1/rpc/*.
--    These are a signup trigger, an RLS bootstrap helper, and the matchmaker
--    (try_match is only ever called server-side from join_queue, which runs as
--    the function owner, so revoking client EXECUTE does not break matchmaking).
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.rls_auto_enable()  from public, anon, authenticated;
revoke execute on function public.try_match()        from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Avatars bucket: public buckets serve objects by direct URL without any
--    SELECT policy, so the broad public SELECT policies only enable *listing*
--    every file. Drop them. Also drop the duplicate `avatars_*` policy set,
--    keeping the original `avatar_*` write policies.
-- ---------------------------------------------------------------------------
drop policy if exists avatar_public_read  on storage.objects;
drop policy if exists avatars_public_read on storage.objects;
drop policy if exists avatars_user_upload on storage.objects;
drop policy if exists avatars_user_update on storage.objects;
drop policy if exists avatars_user_delete on storage.objects;

-- ---------------------------------------------------------------------------
-- 3. Waitlist table (unauthenticated insert) — replace the always-true policy
--    with one that validates the email so it can't be used to write garbage.
-- ---------------------------------------------------------------------------
drop policy if exists waitlist_insert on public.waitlist;
create policy waitlist_insert on public.waitlist
  for insert to anon, authenticated
  with check (
    email is not null
    and char_length(email) between 3 and 254
    and position('@' in email) > 1
  );
