-- ─────────────────────────────────────────────────────────────────────────────
-- get_answer_reveal: self-paced gate.
--
-- 20260718010000 redefined matches.current_index as least(idx_a, idx_b) (the
-- LAGGING player's position, kept only for the spectator RPCs), but this
-- function's gate still assumed lockstep semantics. Concrete failure: whoever
-- answered question k FIRST had current_index <= k, hit 'question still
-- active', and never saw the reveal screen — correctness feedback only worked
-- for the player who was behind. (match-client.tsx calls get_answer_reveal
-- immediately after its own submit; that immediate own-answer reveal is the
-- intended UX, and the caller's is_correct is already readable via the
-- own-rows RLS on match_answers, so this reveals nothing new about timing.)
--
-- New gate, branched exactly like get_match_question / submit_answer /
-- advance_timed_out (20260718010000):
--   • bot match  → old lockstep gates unchanged.
--   • self-paced → the caller may reveal only a question THEY have an answer
--     row for (submitted, or cron skip-row). Completed matches: both players
--     hold 9 rows, so everything reveals, same as before. Abandoned matches:
--     own-rows-only is strictly tighter than the old current_index rule, so
--     the "never reveal unreached questions after a forfeit" invariant holds
--     per-player.
--
-- Body otherwise identical to the latest definition (20260716130000 — the
-- TITA-aware one). Same signature/return type → create or replace, existing
-- grants retained.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function get_answer_reveal(p_match_id uuid, p_index smallint)
returns table (
  correct_index  smallint,
  qtype          text,
  answer_value   text,
  my_answer_text text,
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
  v_bot        boolean;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  v_bot := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  if v_bot then
    -- lockstep (bot) path: unchanged gates from 20260716130000
    if m.status = 'active' and m.current_index <= p_index then
      raise exception 'question still active';
    end if;

    if m.status <> 'completed'
       and (p_index > m.current_index
            or (p_index = m.current_index and m.question_started_at is null)) then
      raise exception 'question not reached';
    end if;
  else
    -- self-paced: reveal only what the caller has an answer row for
    if not exists (
      select 1 from match_answers a
      where a.match_id = p_match_id
        and a.user_id  = auth.uid()
        and a.question_index = p_index
    ) then
      raise exception 'question still active';
    end if;
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.qtype <> 'tita' then
    perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
    select (ord - 1)::smallint into disp_correct
    from unnest(perm) with ordinality as u(p, ord)
    where p = q.correct_index;
  end if;

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query
    select
      disp_correct,
      q.qtype,
      case when q.qtype = 'tita' then q.answer_value else null end,
      a.answer_text,
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
