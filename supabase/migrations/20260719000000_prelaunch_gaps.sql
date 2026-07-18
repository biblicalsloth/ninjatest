-- ─────────────────────────────────────────────────────────────────────────────
-- Pre-launch gap batch (2026-07-19 debug round):
--   1. get_profile: curve points carry `reset` (match_id is null) so the
--      client can render a season soft-reset as a marker instead of a
--      catastrophic pink loss. Data already existed in rating_history; it was
--      dropped before reaching the client.
--   2. get_ninja_history: daily-focus lines and study plans join the union —
--      the page promises "every Ninja output" and these two were missing.
--   3. get_practice_history (new): the caller's past drills — before this,
--      completed practice sessions left no browsable trace anywhere.
--   4. start_practice_similar (new): the first consumer of search_questions.
--      Seeds a practice session with bank questions similar to the caller's
--      misses in a FINISHED match. The embedding is server-derived (the missed
--      question's own stored vector) per the security note in 20260716180000 —
--      no caller-supplied vector, no similarity score returned, and the
--      questions flow through the fully-guarded practice pipeline.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_profile: + reset flag on curve points ──
-- Recreated from 20260625025215 (its latest definition); adds the inline
-- search_path pin that definition predates.
create or replace function get_profile(p_username text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'rank', (
      select count(*) + 1
      from profiles p2
      where p2.elo > p.elo
    ),
    'curve', (
      select coalesce(jsonb_agg(
        jsonb_build_object('elo', rh.elo_after, 'at', rh.created_at,
                           'delta', rh.delta, 'reset', rh.match_id is null)
        order by rh.created_at
      ), '[]')
      from rating_history rh where rh.user_id = p.id
    )
  )
  from profiles p where p.username = p_username;
$$;

-- ── 2. get_ninja_history: + daily focus + study plans ──
-- Recreated from 20260717160000 (its latest definition). Both new sources are
-- keyed (null, null) so they land in the "general" bucket alongside global
-- coach chat; the `kind` labels them. Plans render as diagnosis + target — the
-- full week lives at /plan.
create or replace function get_ninja_history()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  with items as (
    select match_id, null::uuid as practice_session_id, 'coach'::text as kind,
           null::int as question_index, question, answer as content, created_at
    from ninja_coach_messages where user_id = (select auth.uid())
    union all
    select match_id, null::uuid, 'debrief', null, null, content, created_at
    from ninja_debriefs where user_id = (select auth.uid())
    union all
    select match_id, practice_session_id, 'response', question_index, null, content, created_at
    from ninja_responses where user_id = (select auth.uid())
    union all
    select null::uuid, null::uuid, 'daily', null,
           to_char(day, 'FMDay, DD Mon'), content, created_at
    from ninja_daily_focus where user_id = (select auth.uid())
    union all
    select null::uuid, null::uuid, 'plan', null,
           'Week of ' || to_char(week_start, 'DD Mon'),
           coalesce(plan->>'diagnosis', '') ||
             case when plan->>'target' is not null
                  then E'\n\nTarget: ' || (plan->>'target') else '' end,
           created_at
    from ninja_study_plans where user_id = (select auth.uid())
  ),
  sessions as (
    select
      i.match_id,
      i.practice_session_id,
      max(i.created_at) as last_at,
      jsonb_agg(jsonb_build_object(
        'kind', i.kind,
        'question_index', i.question_index,
        'question', i.question,
        'content', i.content,
        'created_at', i.created_at
      ) order by i.created_at) as session_items
    from items i
    group by i.match_id, i.practice_session_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'match_id', s.match_id,
    'practice_session_id', s.practice_session_id,
    'opponent', case
      when s.match_id is null then null
      else (select p.username from profiles p
            where p.id = case when m.player_a = (select auth.uid()) then m.player_b else m.player_a end)
    end,
    'result', case
      when m.id is null then null
      when m.winner_id = (select auth.uid()) then 'win'
      when m.winner_id is null and m.status = 'completed' then 'draw'
      when m.status in ('completed','abandoned') then 'loss'
      else null end,
    'played_at', coalesce(m.created_at, ps.created_at),
    'last_at', s.last_at,
    'items', s.session_items
  ) order by s.last_at desc), '[]'::jsonb)
  from sessions s
  left join matches m on m.id = s.match_id
  left join practice_sessions ps on ps.id = s.practice_session_id;
$$;

-- ── 3. get_practice_history: the caller's past drills ──
create or replace function get_practice_history()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id', s.id,
    'created_at', s.created_at,
    'completed', s.completed_at is not null,
    'total', coalesce(array_length(s.question_ids, 1), 0),
    'correct', s.correct_count,
    'current_index', s.current_index,
    'sections', (
      select coalesce(jsonb_object_agg(t.sec, jsonb_build_object('total', t.cnt, 'correct', t.cor)), '{}'::jsonb)
      from (
        select q.section::text as sec, count(*) as cnt,
               count(*) filter (where pa.is_correct) as cor
        from unnest(s.question_ids) with ordinality u(qid, ord)
        join questions q on q.id = u.qid
        left join practice_answers pa
          on pa.session_id = s.id and pa.question_index = u.ord - 1
        group by q.section
      ) t
    )
  ) order by s.created_at desc), '[]'::jsonb)
  from (
    select * from practice_sessions
    where user_id = (select auth.uid())
    order by created_at desc
    limit 30
  ) s;
$$;

-- ── 4. start_practice_similar: drill questions similar to a match's misses ──
-- Guards mirror the practice/reveal contracts: participant-only, finished
-- match only, and the drill counts toward the SAME 5-sessions/day cap and rate
-- bucket as start_practice, so total bank exposure stays 45 questions/day.
create or replace function start_practice_similar(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid         uuid := (select auth.uid());
  m           matches%rowtype;
  today_count int;
  misses      uuid[];
  src         record;
  qid         uuid;
  ids         uuid[] := '{}';
  add_ids     uuid[];
  per         int;
  sid         uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('start_practice', 5, 60);

  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if m.status not in ('completed', 'abandoned') then raise exception 'match not finished'; end if;

  select count(*) into today_count
  from practice_sessions
  where user_id = uid and created_at >= date_trunc('day', now());
  if today_count >= 5 then
    raise exception 'daily practice limit reached';
  end if;

  -- Misses = the caller's wrong, skipped, and timed-out questions in this match.
  select coalesce(array_agg(a.question_id), '{}') into misses
  from match_answers a
  where a.match_id = p_match_id and a.user_id = uid and not a.is_correct;

  if coalesce(array_length(misses, 1), 0) = 0 then
    raise exception 'no mistakes to drill';
  end if;

  per := greatest(1, (9 / array_length(misses, 1))::int);

  foreach qid in array misses loop
    exit when coalesce(array_length(ids, 1), 0) >= 9;
    select q.embedding, q.section, q.elo into src from questions q where q.id = qid;

    if src.embedding is not null then
      -- Server-derived vector: the missed question's own stored embedding.
      select coalesce(array_agg(t.id), '{}') into add_ids from (
        select sq.id
        from search_questions(src.embedding, src.section, per + 6, qid) sq
        where sq.id <> all(ids)
        limit per
      ) t;
    else
      -- No embedding (e.g. fresh local stack): fall back to same-section
      -- questions near the missed question's difficulty.
      select coalesce(array_agg(t.id), '{}') into add_ids from (
        select q.id
        from questions q
        where q.section = src.section and q.is_active
          and q.id <> qid and q.id <> all(ids)
        order by abs(q.elo - src.elo), random()
        limit per
      ) t;
    end if;

    ids := ids || add_ids;
  end loop;

  ids := ids[1:9];
  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'no similar questions available';
  end if;

  insert into practice_sessions (user_id, question_ids)
  values (uid, ids)
  returning id into sid;

  return jsonb_build_object('session_id', sid, 'total', array_length(ids, 1));
end; $$;

-- Grants. Supabase default privileges grant EXECUTE to authenticated on every
-- new function, but be explicit either way (and strip public/anon).
revoke execute on function get_practice_history()             from public, anon;
revoke execute on function start_practice_similar(uuid)       from public, anon;
grant  execute on function get_practice_history()             to authenticated, service_role;
grant  execute on function start_practice_similar(uuid)       to authenticated, service_role;
