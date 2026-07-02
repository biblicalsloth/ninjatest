-- Section-specific match modes (spec v1.1: "Quant-only battles"). Scoped to
-- friend challenges only, not ranked queue — splitting the matchmaking pool
-- by section adds real wait-time/liveness complexity for a "nice to have".
-- null = mixed 3-3-3 (current/default behavior).

alter table challenges add column section_mode cat_section;

-- Adding a parameter changes the function's identity (name + arg types), so
-- `create or replace` on the new signature creates a second overload rather
-- than replacing the old one — drop the old 1-arg version explicitly, then
-- the new one needs its grants restated (a freshly created function defaults
-- to PUBLIC execute, which create_challenge must not have).
drop function if exists create_challenge(boolean);

-- NOTE: pinned search_path must include `extensions` here — gen_random_bytes()
-- comes from pgcrypto, which lives in the `extensions` schema, not
-- pg_catalog/public. The blanket pin in 20260627000000_pin_function_search_path.sql
-- missed this: it silently broke the pre-existing create_challenge(boolean)
-- the same way (confirmed live — this is a pre-existing bug, not introduced
-- here). It went unnoticed because the app has had zero real users create a
-- friend challenge since that migration ran (still pre-launch/waitlist mode).
create or replace function create_challenge(
  p_is_rated boolean default true,
  p_section_mode cat_section default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public, extensions as $$
declare c text := encode(gen_random_bytes(4), 'hex');
begin
  insert into challenges(code, host_id, is_rated, section_mode)
  values (c, auth.uid(), p_is_rated, p_section_mode);
  return c;
end;
$$;

revoke execute on function create_challenge(boolean, cat_section) from public, anon;
grant execute on function create_challenge(boolean, cat_section) to authenticated, service_role;

create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  if ch.section_mode is null then
    select array_agg(id) into q_ids from (
      (select id from questions where section='VARC'  and is_active order by random() limit 3)
      union all (select id from questions where section='DILR'  and is_active order by random() limit 3)
      union all (select id from questions where section='QUANT' and is_active order by random() limit 3)
    ) s;
  else
    select array_agg(id) into q_ids from (
      select id from questions where section = ch.section_mode and is_active order by random() limit 9
    ) s;
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;
