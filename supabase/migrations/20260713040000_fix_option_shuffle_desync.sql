-- =========================================================
-- FIX: option-shuffle desync introduced by 20260713030000.
--
-- 20260713030000 (admin console engine) recreated get_match_question and
-- get_answer_reveal from their PRE-SHUFFLE definitions, silently dropping the
-- option-order randomization added in 20260713000300 — while submit_answer
-- (still the 20260713000300 definition) kept un-permuting the submitted index
-- through option_perm(). Net effect: options were displayed in canonical order
-- but scored through a shuffle the player never saw, so submissions could be
-- scored against the wrong option.
--
-- This migration restores the shuffle on the read/reveal side, preserving the
-- `passage` column added by 20260713030000. The invariant, restated:
--
--   get_match_question, submit_answer, and get_answer_reveal MUST share the
--   same option_perm() mapping. Never change one without the other two.
--
-- Return types are unchanged from 20260713030000, so create-or-replace is safe.
-- search_path pinned inline; grants persist across create-or-replace.
-- =========================================================

-- ── Read: serve options in the player's shuffled order, plus passage ─────────
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id uuid,
  section     cat_section,
  body        text,
  options     jsonb,
  cap_ms      integer,
  started_at  timestamptz,
  passage     text
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  cfg       section_config%rowtype;
  perm      integer[];
  shuffled  jsonb;
  v_passage text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select jsonb_agg(q.options -> p order by ord) into shuffled
  from unnest(perm) with ordinality as u(p, ord);

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id,
    q.section,
    q.body,
    shuffled,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at,
    v_passage;
end;
$$;

-- ── Reveal: correct index translated to this player's DISPLAY position ───────
create or replace function get_answer_reveal(p_match_id uuid, p_index smallint)
returns table (
  correct_index  smallint,
  explanation    text,
  points_awarded integer,
  is_correct     boolean,
  passage        text
)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  m            matches%rowtype;
  q            questions%rowtype;
  perm         integer[];
  disp_correct smallint;
  v_passage    text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  -- Only reveal once the question has closed
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select (ord - 1)::smallint into disp_correct
  from unnest(perm) with ordinality as u(p, ord)
  where p = q.correct_index;

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query
    select
      disp_correct,
      q.explanation,
      coalesce(a.points_awarded, 0)::integer,
      coalesce(a.is_correct, false),
      v_passage
    from (select 1) _dummy
    left join match_answers a
      on a.match_id = p_match_id
     and a.user_id  = auth.uid()
     and a.question_index = p_index;
end;
$$;
