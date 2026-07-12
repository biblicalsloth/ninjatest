-- =========================================================
-- OAuth-safe handle_new_user
--
-- The original trigger derived username from raw_user_meta_data->>'username'
-- or the email local-part and inserted it directly. Two failure modes:
--   1. Google OAuth supplies no `username` in metadata, so every Google user
--      falls back to the email local-part — collisions are common.
--   2. A profiles.username unique violation aborts the trigger, which aborts
--      the auth.users insert itself: the user cannot sign up at all.
--
-- This version slugifies the base name, finds a free username with a numeric
-- suffix, and maps Google metadata (`name`, `picture`) onto display_name /
-- avatar_url. A last-resort exception handler retries with a suffix derived
-- from the user id so a concurrent-signup race can never abort auth.
-- =========================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  base      text;
  candidate text;
  n         int := 0;
  dname     text;
  avatar    text;
begin
  base := lower(coalesce(
    nullif(new.raw_user_meta_data->>'username', ''),
    split_part(new.email, '@', 1),
    'player'
  ));
  base := regexp_replace(base, '[^a-z0-9_]', '', 'g');
  if length(base) < 3 then
    base := base || 'player';
  end if;
  base := left(base, 20);

  candidate := base;
  while exists (select 1 from profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 20 - length(n::text)) || n::text;
  end loop;

  dname := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    candidate
  );
  avatar := coalesce(
    nullif(new.raw_user_meta_data->>'avatar_url', ''),
    nullif(new.raw_user_meta_data->>'picture', '')
  );

  begin
    insert into profiles (id, username, display_name, avatar_url)
    values (new.id, candidate, dname, avatar)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- Concurrent signup grabbed the candidate between check and insert.
    insert into profiles (id, username, display_name, avatar_url)
    values (new.id, left(base, 12) || substr(replace(new.id::text, '-', ''), 1, 6), dname, avatar)
    on conflict (id) do nothing;
  end;

  return new;
end;
$$;

-- create or replace preserves ACLs, but re-assert the hardening posture anyway.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
