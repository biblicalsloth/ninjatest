-- ─────────────────────────────────────────────────────────
-- Distractor-aware Ninja: get_question_for_ninja also returns the caller's own
-- answer for the question (canonical index + correctness), so the ask prompt
-- can have the model explain why the user's SPECIFIC wrong pick was tempting,
-- not just why the key is right.
--
-- selected_index in match_answers is canonical (post un-shuffle), matching the
-- canonical options this RPC already returns — the prompt references option
-- TEXT, so per-player display shuffle can't cause letter mismatches.
--
-- Return type changes → DROP + recreate (create-or-replace can't alter OUT
-- columns). Body recreated verbatim from the latest def (20260715010000) with
-- only the two new columns added. Grants re-applied after the drop.
-- ─────────────────────────────────────────────────────────

drop function if exists get_question_for_ninja(uuid, int);

create function get_question_for_ninja(p_match_id uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text,
              my_selected_index smallint, my_is_correct boolean)
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
  -- question never triggers another generation. 3 attempts covers a genuine
  -- retry after a model failure.
  select count(*) into attempts
  from ninja_responses
  where match_id = p_match_id and user_id = (select auth.uid())
    and question_index = p_index;
  if attempts >= 3 then raise exception 'ninja attempt limit reached'; end if;

  select * into q from questions where id = m.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id),
           a.selected_index, a.is_correct
    from (select 1) one
    left join match_answers a
      on a.match_id = p_match_id and a.user_id = (select auth.uid())
     and a.question_index = p_index;
end; $$;

revoke execute on function get_question_for_ninja(uuid, int) from public, anon;
grant  execute on function get_question_for_ninja(uuid, int) to authenticated, service_role;
