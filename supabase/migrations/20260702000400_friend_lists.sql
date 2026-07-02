-- Friend lists (spec v2 social/engagement). Single row per unordered pair,
-- ordered by UUID (least/greatest) so (a,b) and (b,a) can't both exist.
--
-- RLS: enabled with zero policies, matching rpc_rate_limit's pattern — every
-- interaction goes through the security definer RPCs below (each does its
-- own auth.uid() scoping), so there's no need for a client-facing policy.

create table friendships (
  user_a       uuid not null references profiles(id),
  user_b       uuid not null references profiles(id),
  status       text not null default 'pending' check (status in ('pending','accepted')),
  requested_by uuid not null references profiles(id),
  created_at   timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint ordered_pair check (user_a < user_b)
);

alter table friendships enable row level security;

-- Friend search is only ever invoked from a logged-in "add friend" flow —
-- unlike get_leaderboard/get_profile_matches (genuinely public pages),
-- there's no anon use case, so restrict to authenticated rather than
-- defaulting to the public-read convention where it doesn't actually apply.
create or replace function search_profiles(p_query text, p_limit int default 10)
returns table (id uuid, username text, display_name text, avatar_url text, elo int)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select id, username, display_name, avatar_url, elo
  from profiles
  where (username ilike '%' || p_query || '%' or display_name ilike '%' || p_query || '%')
    and id <> auth.uid()
  order by elo desc
  limit p_limit;
$$;

revoke execute on function search_profiles(text, int) from public, anon;
grant execute on function search_profiles(text, int) to authenticated, service_role;

create or replace function send_friend_request(p_target_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if p_target_id = auth.uid() then raise exception 'cannot friend yourself'; end if;
  begin
    insert into friendships(user_a, user_b, status, requested_by)
    values (least(auth.uid(), p_target_id), greatest(auth.uid(), p_target_id), 'pending', auth.uid());
  exception when unique_violation then
    raise exception 'already friends or pending';
  end;
end;
$$;

revoke execute on function send_friend_request(uuid) from public, anon, authenticated;
grant execute on function send_friend_request(uuid) to authenticated, service_role;

create or replace function respond_friend_request(p_other_id uuid, p_accept boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  a uuid := least(auth.uid(), p_other_id);
  b uuid := greatest(auth.uid(), p_other_id);
  f friendships%rowtype;
begin
  select * into f from friendships where user_a = a and user_b = b for update;
  if not found or f.status <> 'pending' then raise exception 'no pending request'; end if;
  if f.requested_by = auth.uid() then raise exception 'cannot respond to your own request'; end if;

  if p_accept then
    update friendships set status = 'accepted' where user_a = a and user_b = b;
  else
    delete from friendships where user_a = a and user_b = b;
  end if;
end;
$$;

revoke execute on function respond_friend_request(uuid, boolean) from public, anon, authenticated;
grant execute on function respond_friend_request(uuid, boolean) to authenticated, service_role;

create or replace function remove_friend(p_other_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  delete from friendships
  where user_a = least(auth.uid(), p_other_id) and user_b = greatest(auth.uid(), p_other_id);
end;
$$;

revoke execute on function remove_friend(uuid) from public, anon, authenticated;
grant execute on function remove_friend(uuid) to authenticated, service_role;

-- Single call returns all three buckets (accepted / incoming / outgoing) —
-- the UI splits on `relation`.
create or replace function get_friends()
returns table (
  other_id     uuid,
  username     text,
  display_name text,
  avatar_url   text,
  elo          int,
  relation     text
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.elo,
    case
      when f.status = 'accepted' then 'accepted'
      when f.requested_by = auth.uid() then 'outgoing'
      else 'incoming'
    end
  from friendships f
  join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where auth.uid() in (f.user_a, f.user_b)
  order by f.created_at desc;
$$;

revoke execute on function get_friends() from public, anon, authenticated;
grant execute on function get_friends() to authenticated, service_role;
