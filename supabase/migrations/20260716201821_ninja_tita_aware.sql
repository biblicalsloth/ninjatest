-- ─────────────────────────────────────────────────────────
-- Ninja AI learns about TITA.
--
-- 20260716130000 shipped TITA end-to-end through the MATCH flow (qtype,
-- questions.answer_value, match_answers.answer_text, tita_matches scoring) and
-- 52 TITA questions are live and is_active. But every Ninja read path predates
-- it and still assumes MCQ:
--
--   1. get_question_for_ninja returns options + correct_index only. A TITA row
--      has options = '[]' and correct_index = 0, so the ask prompt built from
--      it told the model "Correct answer: A. " — a BLANK key — and gave it no
--      options. Ninja then answered unanchored and could not self-check, on
--      every TITA question on the result page.
--   2. The caller's own answer is match_answers.answer_text for TITA;
--      selected_index stays null. The prompt read that null as a skip, so a
--      user who typed a wrong answer was told they skipped.
--   3. get_recent_mistakes (the coach's get_my_recent_mistakes tool) indexes
--      options ->> correct_index → null for TITA, and used
--      "selected_index is null" as the skip notion. So the coach was fed
--      correct_answer: null, your_answer: null, skipped: true for every wrong
--      TITA attempt — a hallucination invitation on a tool whose whole point
--      is grounding.
--
-- get_debrief_data already carries qtype and the correct skip notion
-- (selected_index is null AND answer_text is null); this brings the other two
-- reads to the same standard. That skip notion is the single definition — it
-- is what 20260716130000 established and what submit_answer scores against.
--
-- Both bodies recreated from their LATEST live definitions (get_question_for_ninja
-- from 20260715050000_ninja_pick_aware, get_recent_mistakes from
-- 20260715130000_ninja_coach_memory_mistakes), per the migration discipline in
-- CLAUDE.md — only the TITA columns/branches are added. search_path pinned
-- inline; grants re-applied after the drop.
-- ─────────────────────────────────────────────────────────

-- ── get_question_for_ninja: qtype + answer_value + the caller's typed answer ──
-- Return type changes → DROP + recreate (create-or-replace can't alter OUT cols).
drop function if exists get_question_for_ninja(uuid, int);

create function get_question_for_ninja(p_match_id uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text,
              my_selected_index smallint, my_is_correct boolean,
              qtype text, answer_value text, my_answer_text text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype; q questions%rowtype; attempts int;
begin
  if p_index < 0 or p_index > 8 then raise exception 'bad index'; end if;
  select * into m from matches where id = p_match_id;
  if not found or (select auth.uid()) not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  -- Post-match only: no asks of any kind while the match is live.
  if m.status = 'active' then
    raise exception 'match still active';
  end if;

  -- On abandoned/pending matches, only questions actually served may be
  -- revealed — mirrors get_answer_reveal (20260713090000).
  if m.status <> 'completed'
     and (p_index > m.current_index
          or (p_index = m.current_index and m.question_started_at is null)) then
    raise exception 'question not reached';
  end if;

  -- Per-(match, question, user) re-ask ceiling — pre-spend, so an exhausted
  -- question never triggers another generation.
  select count(*) into attempts
  from ninja_responses
  where match_id = p_match_id and user_id = (select auth.uid())
    and question_index = p_index;
  if attempts >= 3 then raise exception 'ninja attempt limit reached'; end if;

  select * into q from questions where id = m.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id),
           a.selected_index, a.is_correct,
           q.qtype, q.answer_value, a.answer_text
    from (select 1) one
    left join match_answers a
      on a.match_id = p_match_id and a.user_id = (select auth.uid())
     and a.question_index = p_index;
end; $$;

revoke execute on function get_question_for_ninja(uuid, int) from public, anon;
grant  execute on function get_question_for_ninja(uuid, int) to authenticated, service_role;

-- ── get_recent_mistakes: answer the coach in TITA's own terms ──
-- Same guards and limits; only the three answer fields branch on qtype, and the
-- skip notion moves to the canonical (selected_index is null AND answer_text is
-- null) so a typed wrong answer stops reporting as a skip.
create or replace function get_recent_mistakes(p_limit int default 10)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'section',        x.section,
    'qtype',          x.qtype,
    'question',       x.body,
    'your_answer',    case when x.qtype = 'tita' then x.answer_text
                           when x.selected_index is null then null
                           else x.options ->> x.selected_index end,
    'correct_answer', case when x.qtype = 'tita' then x.answer_value
                           else x.options ->> x.correct_index end,
    'skipped',        x.selected_index is null and x.answer_text is null,
    'explanation',    x.explanation,
    'played_at',      x.played_at
  ) order by x.played_at desc), '[]'::jsonb)
  from (
    select q.section, q.qtype, q.body, q.options, q.correct_index, q.answer_value,
           q.explanation, a.selected_index, a.answer_text, m.created_at as played_at
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

revoke execute on function get_recent_mistakes(int) from public, anon;
grant  execute on function get_recent_mistakes(int) to authenticated, service_role;
