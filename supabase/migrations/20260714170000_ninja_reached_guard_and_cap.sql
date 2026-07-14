-- Ninja AI hardening (audit findings #1 + #2):
--
-- #1 (CRITICAL answer-key leak): get_question_for_ninja carried only the
--    active-status guard, missing the "question not reached" gate that
--    get_answer_reveal has (20260713090000). On an abandoned/pending match a
--    participant could pull correct_index + explanation for questions the match
--    never served — the same bank-tail harvest get_answer_reveal was hardened
--    against, reopened via Ninja. Add the identical gate.
--
-- #2 (cost abuse): no cap on re-asking the same question — history is
--    append-only, so 15/min/user meant unbounded paid LLM spend per question.
--    Cap attempts per (match, question, user) BEFORE the caller spends tokens.
--    Rate-limit fail-open is fixed caller-side (route fails closed on the paid
--    endpoint); this is the durable per-question ceiling.
--
-- Recreated from the latest definition (20260714150000). search_path pinned
-- inline; grants re-applied since create-or-replace resets them.

create or replace function get_question_for_ninja(p_match_id uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype; q questions%rowtype; attempts int;
begin
  if p_index < 0 or p_index > 8 then raise exception 'bad index'; end if;
  select * into m from matches where id = p_match_id;
  if not found or (select auth.uid()) not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  -- #1: on abandoned/pending matches, only questions actually served may be
  -- revealed — mirrors get_answer_reveal (20260713090000).
  if m.status <> 'completed'
     and (p_index > m.current_index
          or (p_index = m.current_index and m.question_started_at is null)) then
    raise exception 'question not reached';
  end if;

  -- #2: per-(match, question, user) re-ask ceiling — pre-spend, so an
  -- exhausted question never triggers another generation. 3 attempts is enough
  -- to cover a genuine retry after a model failure.
  select count(*) into attempts
  from ninja_responses
  where match_id = p_match_id and user_id = (select auth.uid())
    and question_index = p_index;
  if attempts >= 3 then raise exception 'ninja attempt limit reached'; end if;

  select * into q from questions where id = m.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id);
end; $$;

revoke execute on function get_question_for_ninja(uuid,int) from public, anon;
grant  execute on function get_question_for_ninja(uuid,int) to authenticated, service_role;
