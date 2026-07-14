-- ─────────────────────────────────────────────────────────
-- Ninja daily focus: one AI-personalized challenge line per player per day,
-- shown next to the derived daily tasks in the lobby. Cached by (user, day) so
-- it costs at most one LLM call per player per day; the route double-checks
-- the cache and save_ninja_daily_focus is first-write-wins.
-- ─────────────────────────────────────────────────────────

create table if not exists ninja_daily_focus (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null default (now()::date),
  content    text not null,
  model_id   text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- RLS on, zero policies: definer-only.
alter table ninja_daily_focus enable row level security;

create or replace function get_ninja_daily_focus()
returns table(content text, day date)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select f.content, f.day
  from ninja_daily_focus f
  where f.user_id = (select auth.uid()) and f.day = now()::date;
$$;

create or replace function save_ninja_daily_focus(p_model text, p_content text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if coalesce(btrim(p_content), '') = '' then raise exception 'empty content'; end if;
  insert into ninja_daily_focus (user_id, content, model_id)
  values ((select auth.uid()), left(p_content, 500), left(p_model, 200))
  on conflict (user_id, day) do nothing;
end; $$;

revoke execute on function get_ninja_daily_focus()             from public, anon;
revoke execute on function save_ninja_daily_focus(text, text)  from public, anon;
grant  execute on function get_ninja_daily_focus()             to authenticated, service_role;
grant  execute on function save_ninja_daily_focus(text, text)  to authenticated, service_role;
