-- Anti-cheat telemetry: capture-only, no enforcement.
--   client-side  : tab_hidden / window_blur logged via log_match_event()
--   server-side  : implausibly-fast correct answers flagged in submit_answer
-- Rows are written only through SECURITY DEFINER RPCs; RLS with no policies keeps
-- the table opaque to clients. Review signals in Supabase Studio.

create table if not exists match_events (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references matches(id)  on delete cascade,
  user_id        uuid not null references profiles(id) on delete cascade,
  question_index smallint,
  event_type     text not null,
  meta           jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_match_events_match on match_events(match_id);

alter table match_events enable row level security;
-- No policies: only reachable via the SECURITY DEFINER functions below.

create or replace function log_match_event(
  p_match_id uuid, p_question_index smallint, p_event_type text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype;
begin
  -- Whitelist the client-reportable events; server-only types (e.g. fast_answer)
  -- are never accepted here.
  if p_event_type not in ('tab_hidden', 'window_blur') then
    raise exception 'invalid event type';
  end if;

  perform check_rate_limit('log_match_event', 40, 10);

  select * into m from matches where id = p_match_id;
  if not found or auth.uid() not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  insert into match_events(match_id, user_id, question_index, event_type)
  values (p_match_id, auth.uid(), p_question_index, p_event_type);
end; $$;

revoke execute on function log_match_event(uuid, smallint, text) from public, anon;
grant  execute on function log_match_event(uuid, smallint, text) to authenticated, service_role;
