-- Unify admin gating on profiles.is_admin (was: get_waitlist_admin used an email
-- allowlist; the WIP question-uploader used is_admin). One gate now: is_admin.
--
-- is_admin must be server-writable ONLY — guard it in the profiles self-update
-- policy exactly like elo/stats, or a user could UPDATE their own row to admin.
-- The DB currently has 0 users, so the owner is granted admin on signup via
-- handle_new_user (a one-time seed alone would miss a later signup).

alter table profiles add column if not exists is_admin boolean not null default false;

-- Add is_admin to the self-update guard (preserves the policy's existing roles).
alter policy profiles_update on profiles with check (
      (id = (select auth.uid()))
  and (elo            = (select p.elo            from profiles p where p.id = (select auth.uid())))
  and (peak_elo       = (select p.peak_elo       from profiles p where p.id = (select auth.uid())))
  and (wins           = (select p.wins           from profiles p where p.id = (select auth.uid())))
  and (losses         = (select p.losses         from profiles p where p.id = (select auth.uid())))
  and (draws          = (select p.draws          from profiles p where p.id = (select auth.uid())))
  and (matches_played = (select p.matches_played from profiles p where p.id = (select auth.uid())))
  and (is_admin       = (select p.is_admin       from profiles p where p.id = (select auth.uid())))
);

-- Grant admin to the owner on account creation (and seed any existing row).
create or replace function handle_new_user()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  insert into profiles (id, username, display_name, avatar_url, is_admin)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url',
    new.email = 'arcxx1995@gmail.com'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = 'arcxx1995@gmail.com';
  if v_id is not null then
    update profiles set is_admin = true where id = v_id;
  end if;
end $$;

-- Waitlist viewer now gates on is_admin instead of the JWT email.
create or replace function get_waitlist_admin()
returns setof waitlist
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select is_admin from profiles where id = auth.uid()), false) then
    raise exception 'forbidden';
  end if;
  return query select * from waitlist order by created_at desc;
end; $$;
