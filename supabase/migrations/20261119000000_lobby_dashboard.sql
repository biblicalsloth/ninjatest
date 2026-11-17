-- Lobby dashboard redesign: study-plan timeline + recent-match detail.
--
-- 1. profiles.study_start_time — when the user's study day starts; the lobby
--    timeline stacks today's plan tasks from it. Not in the profiles_update
--    WITH CHECK freeze list, so the existing self-update policy covers it.
--    profiles is world-readable, so this time is public (a clock time, harmless).
alter table profiles add column if not exists study_start_time time;

-- 2. get_week_activity — which sections the caller touched on each day of a
--    week, in the caller's timezone. Drives the week-strip activity dots and
--    the timeline's auto-done ("any activity in that section today").
--    Own rows only (auth.uid()); returns section names, never question data.
create or replace function get_week_activity(p_week_start date default null, p_tz text default 'UTC')
returns table(day date, sections text[])
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  uid uuid := (select auth.uid());
  tz  text := 'UTC';
  ws  date := coalesce(p_week_start, date_trunc('week', now())::date);
begin
  if uid is null then raise exception 'forbidden'; end if;
  -- An unknown tz name would raise inside AT TIME ZONE; fall back instead.
  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then
    tz := p_tz;
  end if;

  return query
  with acts as (
    select (ma.answered_at at time zone tz)::date as d, q.section::text as s
      from match_answers ma
      join questions q on q.id = ma.question_id
     where ma.user_id = uid
       and ma.answered_at >= (ws::timestamp - interval '1 day') at time zone tz
       and ma.answered_at <  (ws::timestamp + interval '8 days') at time zone tz
    union
    select (pa.answered_at at time zone tz)::date, q.section::text
      from practice_sessions ps
      join practice_answers pa on pa.session_id = ps.id
      join questions q on q.id = ps.question_ids[pa.question_index + 1]
     where ps.user_id = uid
       and pa.answered_at >= (ws::timestamp - interval '1 day') at time zone tz
       and pa.answered_at <  (ws::timestamp + interval '8 days') at time zone tz
  )
  select a.d, array_agg(distinct a.s order by a.s)
    from acts a
   where a.d >= ws and a.d < ws + 7
   group by a.d
   order by a.d;
end;
$$;

-- 3. get_match_section_breakdown — the caller's OWN answers in a finished
--    match, rolled up per section. Participant-only and finished-only, so it
--    can't be used to peek at a live match.
create or replace function get_match_section_breakdown(p_match_id uuid)
returns table(section text, answered int, correct int, points int)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'forbidden'; end if;
  if not exists (
    select 1 from matches m
     where m.id = p_match_id
       and uid in (m.player_a, m.player_b)
       and m.status in ('completed', 'abandoned')
  ) then
    raise exception 'match not available';
  end if;

  return query
  select q.section::text,
         count(*)::int,
         count(*) filter (where ma.is_correct)::int,
         coalesce(sum(ma.points_awarded), 0)::int
    from match_answers ma
    join questions q on q.id = ma.question_id
   where ma.match_id = p_match_id and ma.user_id = uid
   group by q.section
   order by q.section;
end;
$$;

revoke execute on function get_week_activity(date, text)       from public, anon;
revoke execute on function get_match_section_breakdown(uuid)   from public, anon;
grant  execute on function get_week_activity(date, text)       to authenticated, service_role;
grant  execute on function get_match_section_breakdown(uuid)   to authenticated, service_role;
