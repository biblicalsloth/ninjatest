-- Direct friend-challenges + direct messaging between accepted friends.
--
-- Friend requests already exist (20260702000400_friend_lists.sql). This adds:
--   1. An advisory `target_id` on challenges so a challenge can be aimed at a
--      specific friend and surfaced to them (get_incoming_challenges). It is
--      NOT enforced in accept_challenge (the code still works for anyone who
--      has it) — deliberately, so the large latest accept_challenge
--      (20260713050000) is left untouched. The target only drives whose inbox
--      the challenge shows up in.
--   2. `direct_messages` — participant-readable (RLS SELECT) so Supabase
--      realtime postgres_changes works the same way it does for `matches`.
--      Writes go only through send_message() (friendship + rate-limit checks).

-- 1. Direct challenges -------------------------------------------------------

alter table challenges add column target_id uuid references profiles(id);

-- Adding a parameter creates a new overload; drop the 2-arg version first so
-- named-arg calls don't become ambiguous (same reason 20260702000100 dropped
-- the 1-arg version). Existing callers pass p_is_rated (+ p_section_mode) and
-- resolve cleanly to the 3-arg form via the p_target_id default.
drop function if exists create_challenge(boolean, cat_section);

create or replace function create_challenge(
  p_is_rated boolean default true,
  p_section_mode cat_section default null,
  p_target_id uuid default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public, extensions as $$
declare c text := encode(gen_random_bytes(4), 'hex');
begin
  insert into challenges(code, host_id, is_rated, section_mode, target_id)
  values (c, auth.uid(), p_is_rated, p_section_mode, p_target_id);
  return c;
end;
$$;

revoke execute on function create_challenge(boolean, cat_section, uuid) from public, anon;
grant execute on function create_challenge(boolean, cat_section, uuid) to authenticated, service_role;

-- Pending challenges aimed at the caller (unaccepted, unexpired).
create or replace function get_incoming_challenges()
returns table (
  code         text,
  host_id      uuid,
  username     text,
  display_name text,
  avatar_url   text,
  elo          int,
  is_rated     boolean,
  section_mode cat_section,
  expires_at   timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select c.code, c.host_id, p.username, p.display_name, p.avatar_url,
         p.elo, c.is_rated, c.section_mode, c.expires_at
  from challenges c
  join profiles p on p.id = c.host_id
  where c.target_id = auth.uid()
    and c.guest_id is null
    and c.match_id is null
    and now() < c.expires_at
  order by c.created_at desc;
$$;

revoke execute on function get_incoming_challenges() from public, anon;
grant execute on function get_incoming_challenges() to authenticated, service_role;

-- 2. Direct messaging --------------------------------------------------------

create table direct_messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references profiles(id),
  recipient_id uuid not null references profiles(id),
  body         text not null check (char_length(body) between 1 and 2000),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  constraint no_self_message check (sender_id <> recipient_id)
);

create index direct_messages_recipient_unread_idx on direct_messages (recipient_id, read_at);
create index direct_messages_thread_idx on direct_messages (sender_id, recipient_id, created_at);
create index direct_messages_thread_rev_idx on direct_messages (recipient_id, sender_id, created_at);

alter table direct_messages enable row level security;

-- Participants read their own thread (this is what powers postgres_changes
-- realtime, exactly like the `matches` participant policy). No INSERT/UPDATE
-- policy: sending goes through send_message(), marking-read through
-- mark_messages_read() — both security definer.
create policy dm_select_participant on direct_messages
  for select using ((select auth.uid()) in (sender_id, recipient_id));

-- Include in the realtime publication. Guarded so it's a no-op whether the
-- project's publication is FOR ALL TABLES or an explicit table list.
do $$ begin
  alter publication supabase_realtime add table direct_messages;
exception when others then null; end $$;

create or replace function send_message(p_recipient_id uuid, p_body text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  a uuid := least(auth.uid(), p_recipient_id);
  b uuid := greatest(auth.uid(), p_recipient_id);
  clean text := left(trim(p_body), 2000);
  new_id uuid;
begin
  if p_recipient_id = auth.uid() then raise exception 'cannot message yourself'; end if;
  if not exists (
    select 1 from friendships
    where user_a = a and user_b = b and status = 'accepted'
  ) then
    raise exception 'not friends';
  end if;
  perform check_rate_limit('send_message', 30, 10);
  if char_length(coalesce(clean, '')) = 0 then raise exception 'empty message'; end if;

  insert into direct_messages(sender_id, recipient_id, body)
  values (auth.uid(), p_recipient_id, clean)
  returning id into new_id;
  return new_id;
end;
$$;

revoke execute on function send_message(uuid, text) from public, anon, authenticated;
grant execute on function send_message(uuid, text) to authenticated, service_role;

create or replace function mark_messages_read(p_other_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  update direct_messages set read_at = now()
  where recipient_id = auth.uid() and sender_id = p_other_id and read_at is null;
end;
$$;

revoke execute on function mark_messages_read(uuid) from public, anon, authenticated;
grant execute on function mark_messages_read(uuid) to authenticated, service_role;
