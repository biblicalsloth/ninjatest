-- ─────────────────────────────────────────────────────────
-- AI distractor generator support: targeted options update.
--
-- The AI proposes better distractors for an existing question; applying them
-- must touch ONLY options/correct_index/explanation. Routing the apply through
-- admin_upsert_questions' update branch would wipe image_url/duration_ms
-- (admin_list_questions doesn't return them, so the client can't echo them
-- back) — hence a dedicated narrow RPC instead of widening the upsert.
-- ─────────────────────────────────────────────────────────

create or replace function admin_update_question_options(
  p_id            uuid,
  p_options       jsonb,
  p_correct_index int,
  p_explanation   text default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  if jsonb_typeof(p_options) is distinct from 'array'
     or coalesce(jsonb_array_length(p_options), 0) < 2 then
    raise exception 'options must be an array of 2+ strings';
  end if;
  if exists (select 1 from jsonb_array_elements(p_options) e where jsonb_typeof(e) <> 'string') then
    raise exception 'options must all be strings';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p_options) e
             where length(e) > 1000 or btrim(e) = '') then
    raise exception 'options must be non-empty and at most 1000 chars';
  end if;
  if p_correct_index is null or p_correct_index < 0
     or p_correct_index > jsonb_array_length(p_options) - 1 then
    raise exception 'correct_index out of range';
  end if;
  if p_explanation is not null and length(p_explanation) > 4000 then
    raise exception 'explanation too long (max 4000 chars)';
  end if;

  update questions set
    options       = p_options,
    correct_index = p_correct_index::smallint,
    explanation   = coalesce(p_explanation, explanation)
  where id = p_id;
  if not found then
    raise exception 'question not found';
  end if;
end; $$;

revoke execute on function admin_update_question_options(uuid, jsonb, int, text) from public, anon;
grant  execute on function admin_update_question_options(uuid, jsonb, int, text) to authenticated, service_role;
