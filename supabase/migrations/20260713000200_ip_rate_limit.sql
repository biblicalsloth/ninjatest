-- Durable, IP-keyed rate limiter for the unauthenticated / low-auth API routes
-- (waitlist + email). Replaces the per-serverless-instance in-memory limiter in
-- lib/rate-limit.ts, which reset on every cold start. Mirrors check_rate_limit
-- but keys on an arbitrary text bucket (client IP) and RETURNS a retry-after in
-- seconds (0 = allowed) instead of raising, so routes can answer 429 cleanly.

create table if not exists ip_rate_limit (
  ip_key       text not null,
  fn_name      text not null,
  window_start timestamptz not null default now(),
  count        integer not null default 1,
  primary key (ip_key, fn_name)
);

alter table ip_rate_limit enable row level security;
-- No policies: only reachable via the SECURITY DEFINER function below.

create or replace function check_ip_rate_limit(
  p_key text, p_fn text, p_limit integer, p_window_seconds integer
) returns integer
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare existing ip_rate_limit%rowtype;
begin
  select * into existing from ip_rate_limit
  where ip_key = p_key and fn_name = p_fn for update;

  if not found then
    insert into ip_rate_limit(ip_key, fn_name) values (p_key, p_fn)
    on conflict (ip_key, fn_name) do update set count = ip_rate_limit.count + 1;
    return 0;
  end if;

  if now() > existing.window_start + make_interval(secs => p_window_seconds) then
    update ip_rate_limit set window_start = now(), count = 1
    where ip_key = p_key and fn_name = p_fn;
    return 0;
  end if;

  if existing.count >= p_limit then
    return greatest(1, ceil(extract(epoch from
      (existing.window_start + make_interval(secs => p_window_seconds) - now())))::int);
  end if;

  update ip_rate_limit set count = count + 1
  where ip_key = p_key and fn_name = p_fn;
  return 0;
end; $$;

revoke execute on function check_ip_rate_limit(text, text, integer, integer) from public;
grant  execute on function check_ip_rate_limit(text, text, integer, integer) to anon, authenticated, service_role;
