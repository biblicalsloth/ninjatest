-- ─────────────────────────────────────────────────────────
-- Ninja explanations in solo practice drills.
--
-- Practice already reveals the bank's own correct_index + explanation the
-- instant an answer is locked (submit_practice_answer). What it had no path to
-- was Ninja: /api/ninja/ask only knew get_question_for_ninja, which is
-- match-scoped (participant + reached + 3-attempt ceiling, all keyed on
-- matches). A practice drill has no match row, so the entire feature was
-- unreachable from /practice.
--
-- This adds the practice-shaped twin of that surface — same three guards, same
-- return shape, so the route reuses buildQuestionPrompt untouched:
--   * ownership   — practice_sessions.user_id = auth.uid()  (was: participant)
--   * reveal gate — an answer row must exist for the index  (was: reached)
--   * cost guard  — 3 asks per (session, question, user), checked PRE-spend
--
-- The reveal gate is the load-bearing one. get_question_for_ninja's reach guard
-- exists so an abandoned match can't be mined for unseen questions; the practice
-- equivalent is "you already locked an answer", because that is the exact moment
-- submit_practice_answer hands over the key anyway. Asking before answering
-- would turn Ninja into a bank-scraping oracle over the 45 questions/day a user
-- can pull — questions is RLS `using(false)` precisely to prevent that.
--
-- Storage reuses ninja_responses rather than a parallel table: match_id becomes
-- nullable, practice_session_id joins it, and a XOR check keeps every row
-- attributable to exactly one source. That keeps the pre-spend attempt count a
-- single-table read and keeps /ninja history one union.
--
-- get_ninja_history is recreated from its LATEST definition (20260715120000),
-- per CLAUDE.md migration discipline — only the practice grouping is added.
-- Practice is MCQ-only (start_practice picks no TITA), so qtype is always 'mcq'
-- here; the TITA columns are returned anyway for shape parity with the match
-- twin, so a TITA-aware practice mode needs no change on this side.
-- ─────────────────────────────────────────────────────────

-- ── ninja_responses: admit practice rows ──
alter table ninja_responses alter column match_id drop not null;

alter table ninja_responses
  add column if not exists practice_session_id uuid
    references practice_sessions(id) on delete cascade;

-- Exactly one source per row. Every pre-existing row has match_id set, so this
-- validates as-is.
alter table ninja_responses drop constraint if exists ninja_responses_one_source;
alter table ninja_responses add constraint ninja_responses_one_source
  check (num_nonnulls(match_id, practice_session_id) = 1);

create index if not exists ninja_responses_practice_idx
  on ninja_responses (user_id, practice_session_id, question_index, created_at desc)
  where practice_session_id is not null;

-- ── serve a practice question to Ninja (mirrors get_question_for_ninja) ──
create or replace function get_practice_question_for_ninja(p_session uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text,
              my_selected_index smallint, my_is_correct boolean,
              qtype text, answer_value text, my_answer_text text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  s        practice_sessions%rowtype;
  q        questions%rowtype;
  a        practice_answers%rowtype;
  attempts int;
begin
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  if p_index < 0 or p_index >= coalesce(array_length(s.question_ids, 1), 0) then
    raise exception 'bad index';
  end if;

  -- Reveal gate: only an ANSWERED question may be sent to Ninja. Until the
  -- answer is locked, submit_practice_answer hasn't revealed the key either.
  select * into a from practice_answers
  where session_id = p_session and question_index = p_index;
  if not found then raise exception 'question not answered'; end if;

  -- Per-(session, question, user) re-ask ceiling — pre-spend, so an exhausted
  -- question never triggers another generation. Same 3 as the match path.
  select count(*) into attempts
  from ninja_responses
  where practice_session_id = p_session and user_id = (select auth.uid())
    and question_index = p_index;
  if attempts >= 3 then raise exception 'ninja attempt limit reached'; end if;

  select * into q from questions where id = s.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id),
           a.selected_index, a.is_correct,
           q.qtype, q.answer_value, null::text;
end; $$;

-- ── save one practice response (route calls after a non-empty generation) ──
create or replace function save_ninja_practice_response(
  p_session uuid, p_index int, p_model text, p_content text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s      practice_sessions%rowtype;
  uid    uuid := (select auth.uid());
  new_id uuid;
begin
  if coalesce(btrim(p_content), '') = '' then raise exception 'empty content'; end if;
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> uid then raise exception 'forbidden'; end if;
  if p_index < 0 or p_index >= coalesce(array_length(s.question_ids, 1), 0) then
    raise exception 'bad index';
  end if;
  if not exists (
    select 1 from practice_answers
    where session_id = p_session and question_index = p_index
  ) then raise exception 'question not answered'; end if;

  insert into ninja_responses (user_id, practice_session_id, question_index, model_id, content)
  values (uid, p_session, p_index, left(p_model, 200), left(p_content, 20000))
  returning id into new_id;
  return new_id;
end; $$;

-- ── read caller's own saved practice answers for a question ──
create or replace function get_ninja_practice_responses(p_session uuid, p_index int)
returns table(id uuid, model_id text, content text, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select r.id, r.model_id, r.content, r.created_at
  from ninja_responses r
  where r.practice_session_id = p_session and r.question_index = p_index
    and r.user_id = (select auth.uid())
  order by r.created_at desc;
$$;

-- ── /ninja history: practice drills are their own sessions ──
-- Recreated from 20260715120000 (its latest definition). Only change: the
-- session key widens from match_id to (match_id, practice_session_id), so
-- practice asks group per drill instead of collapsing into the null-match_id
-- "General chat" bucket alongside global coach turns.
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

revoke execute on function get_practice_question_for_ninja(uuid, int)          from public, anon;
revoke execute on function save_ninja_practice_response(uuid, int, text, text) from public, anon;
revoke execute on function get_ninja_practice_responses(uuid, int)             from public, anon;
revoke execute on function get_ninja_history()                                 from public, anon;

grant execute on function get_practice_question_for_ninja(uuid, int)           to authenticated, service_role;
grant execute on function save_ninja_practice_response(uuid, int, text, text)  to authenticated, service_role;
grant execute on function get_ninja_practice_responses(uuid, int)              to authenticated, service_role;
grant execute on function get_ninja_history()                                  to authenticated, service_role;
