-- In-app waitlist viewer, gated by an email allowlist. There is no admin UI
-- otherwise (Supabase Studio was the only way to read signups).
-- ponytail: single hardcoded admin email; promote to an `admins` table if a
-- second admin ever needs access.
create or replace function get_waitlist_admin()
returns setof waitlist
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
begin
  if coalesce(auth.jwt() ->> 'email', '') <> 'arcxx1995@gmail.com' then
    raise exception 'forbidden';
  end if;
  return query select * from waitlist order by created_at desc;
end; $$;

revoke execute on function get_waitlist_admin() from public, anon;
grant  execute on function get_waitlist_admin() to authenticated, service_role;
