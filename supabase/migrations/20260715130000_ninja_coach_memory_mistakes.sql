-- ─────────────────────────────────────────────────────────
-- Study-buddy upgrade for Ninja Coach: two definer reads.
--   1. get_recent_coach_turns — replay the last N coach turns of a thread so
--      the agent has conversational memory (ninja_coach_messages is RLS-on /
--      zero-policy, so the route can't select it directly).
--   2. get_recent_mistakes — the caller's recent wrong/skipped questions across
--      finished matches, for concrete question-specific coaching.
-- Both mirror the ninja_debrief / coach_history idioms verbatim.
-- ─────────────────────────────────────────────────────────

-- ── last N coach turns for a thread (null match = the "General" bucket) ──
-- Returned oldest-first, ready to splat into the model's message array.
create or replace function get_recent_coach_turns(p_match_id uuid, p_limit int default 8)
returns table(question text, answer text, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select t.question, t.answer, t.created_at from (
    select question, answer, created_at
    from ninja_coach_messages
    where user_id = (select auth.uid())
      and match_id is not distinct from p_match_id   -- null-safe bucket match
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 20))
  ) t
  order by t.created_at asc;
$$;

-- ── caller's recent wrong or skipped questions across finished matches ──
-- is_correct=false covers both a wrong pick and a skip; the 'skipped' flag
-- distinguishes. Revealing the correct answer here is safe: own data, post-match
-- only. selected_index is canonical (post-unshuffle) so it indexes options directly.
create or replace function get_recent_mistakes(p_limit int default 10)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'section',        x.section,
    'question',       x.body,
    'your_answer',    case when x.selected_index is null then null
                           else x.options ->> x.selected_index end,
    'correct_answer', x.options ->> x.correct_index,
    'skipped',        x.selected_index is null,
    'explanation',    x.explanation,
    'played_at',      x.played_at
  ) order by x.played_at desc), '[]'::jsonb)
  from (
    select q.section, q.body, q.options, q.correct_index, q.explanation,
           a.selected_index, m.created_at as played_at
    from match_answers a
    join matches m   on m.id = a.match_id
    join questions q on q.id = m.question_ids[a.question_index + 1]
    where a.user_id = (select auth.uid())
      and a.is_correct = false
      and m.status in ('completed', 'abandoned')
    order by m.created_at desc, a.question_index
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  ) x;
$$;

revoke execute on function get_recent_coach_turns(uuid, int) from public, anon;
revoke execute on function get_recent_mistakes(int)          from public, anon;
grant  execute on function get_recent_coach_turns(uuid, int) to authenticated, service_role;
grant  execute on function get_recent_mistakes(int)          to authenticated, service_role;
