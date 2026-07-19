-- Heal avatar storage write-policy drift.
--
-- 20260624092649 created avatars_user_{upload,update,delete} on storage.objects.
-- 20260627000100 dropped them on a wrong assumption that a singular avatar_* write set
-- existed to keep — it never did in the repo. No migration recreated any write policy, so
-- a fresh `db reset` / local stack leaves storage.objects with ZERO avatar write policies
-- and every user's avatar upload fails RLS. (Prod currently works only because the singular
-- avatar_user_* policies were hand-patched in out-of-band — invisible to the repo.)
--
-- Recreate the canonical write set idempotently and collapse the out-of-band singular
-- variants so exactly one set remains. Do NOT recreate a public-read SELECT policy:
-- 20260627000100 dropped it deliberately so the public `avatars` bucket isn't listable;
-- individual avatars stay readable through the public bucket's /object/public URL.

drop policy if exists "avatars_user_upload" on storage.objects;
drop policy if exists "avatars_user_update" on storage.objects;
drop policy if exists "avatars_user_delete" on storage.objects;
drop policy if exists "avatar_user_upload"  on storage.objects;
drop policy if exists "avatar_user_update"  on storage.objects;
drop policy if exists "avatar_user_delete"  on storage.objects;

create policy "avatars_user_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_user_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_user_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
