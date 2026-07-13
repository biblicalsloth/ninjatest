-- =========================================================
-- Post-signup onboarding
--
-- handle_new_user already mints a profiles row (auto-slugified username) on
-- every auth insert, so onboarding EDITS that row — it never creates one.
-- New columns: exam / exam_year (survey answers) + onboarding_completed gate.
-- Existing accounts are backfilled to completed so only genuinely-new users
-- see the flow.
--
-- The write goes through a SECURITY DEFINER RPC, not a client UPDATE: username
-- is `unique not null` and needs server-side collision handling, and the
-- server-authoritative invariant forbids trusting the client for guarded state.
-- =========================================================

alter table profiles
  add column if not exists exam                 text,
  add column if not exists exam_year            int,
  add column if not exists onboarding_completed boolean not null default false;

-- Everyone who signed up before onboarding existed skips it.
update profiles set onboarding_completed = true where onboarding_completed = false;

create or replace function complete_onboarding(
  p_display_name text,
  p_username     text,
  p_exam         text,
  p_exam_year    int
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid      uuid := auth.uid();
  v_username text;
  v_dname    text;
  v_year_min int := extract(year from now())::int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- Username: same rules as handle_new_user — slugify, then length-gate.
  v_username := left(regexp_replace(lower(coalesce(p_username, '')), '[^a-z0-9_]', '', 'g'), 20);
  if length(v_username) < 3 then
    raise exception 'Username must be at least 3 characters (letters, numbers, underscore)';
  end if;

  v_dname := btrim(coalesce(p_display_name, ''));
  if length(v_dname) < 1 then
    raise exception 'Name is required';
  end if;
  v_dname := left(v_dname, 40);

  if p_exam is null or p_exam not in ('CAT','XAT','SNAP','NMAT','CMAT','GMAT','Other') then
    raise exception 'Invalid exam';
  end if;

  -- Target year: current year through +3.
  if p_exam_year is null or p_exam_year < v_year_min or p_exam_year > v_year_min + 3 then
    raise exception 'Invalid exam year';
  end if;

  begin
    update profiles
    set display_name         = v_dname,
        username             = v_username,
        exam                 = p_exam,
        exam_year            = p_exam_year,
        onboarding_completed = true
    where id = v_uid;
  exception when unique_violation then
    raise exception 'Username already taken';
  end;
end;
$$;

revoke execute on function complete_onboarding(text, text, text, int) from public, anon;
grant   execute on function complete_onboarding(text, text, text, int) to authenticated;
