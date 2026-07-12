-- =========================================================
-- Admin question-upload console: RPCs
-- All: SECURITY DEFINER, pinned search_path, admin-guard first statement,
-- execute revoked from anon/public and granted to authenticated/service_role.
-- =========================================================

-- ── a) admin_upsert_questions(payload jsonb) -> jsonb ────────────────────────
-- payload = array of GROUP objects (see contract). Per-question validation:
-- a bad question is skipped (collected into `errors`), never aborts the batch.
-- `row` = 1-based index in FLATTENED order (groups in order, questions within).
-- Returns { inserted, updated, errors:[{row,reason}] } (passages not counted).
create or replace function admin_upsert_questions(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  grp                jsonb;
  q                  jsonb;
  n_row              int   := 0;
  v_inserted         int   := 0;
  v_updated          int   := 0;
  v_errors           jsonb := '[]'::jsonb;
  v_section          text;
  v_section_ok       boolean;
  v_passage_text     text;
  v_in_passage_id    uuid;
  v_existing_section text;
  v_refs_passage     boolean;
  v_passage_error    text;
  v_passage_resolved boolean;
  v_resolved_pid     uuid;
  v_err              text;
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  for grp in select jsonb_array_elements(coalesce(payload, '[]'::jsonb)) loop
    -- ── group-level setup ──
    v_section        := grp->>'section';
    v_section_ok     := v_section in ('VARC', 'DILR', 'QUANT');
    v_passage_text   := grp->>'passage';                         -- null if absent/json-null
    v_in_passage_id  := nullif(grp->>'passage_id', '')::uuid;    -- null if absent/json-null
    v_refs_passage   := (v_passage_text is not null) or (v_in_passage_id is not null);
    v_passage_error  := null;
    v_passage_resolved := false;
    v_resolved_pid   := null;

    if not v_section_ok then
      v_passage_error := 'invalid section: ' || coalesce(v_section, '(null)');
    elsif v_in_passage_id is not null then
      select p.section::text into v_existing_section from passages p where p.id = v_in_passage_id;
      if not found then
        v_passage_error := 'passage_id not found';
      elsif v_existing_section <> v_section then
        v_passage_error := format('passage section %s does not match question section %s',
                                  v_existing_section, v_section);
      end if;
    end if;

    -- ── per-question ──
    for q in select jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb)) loop
      n_row := n_row + 1;

      if v_passage_error is not null then
        v_err := v_passage_error;
      elsif coalesce(btrim(q->>'body'), '') = '' then
        v_err := 'body is empty or blank';
      elsif jsonb_typeof(q->'options') is distinct from 'array'
            or coalesce(jsonb_array_length(q->'options'), 0) = 0 then
        v_err := 'options must be a non-empty array';
      elsif exists (select 1 from jsonb_array_elements(q->'options') e where jsonb_typeof(e) <> 'string') then
        v_err := 'options must all be strings';
      elsif (q->>'correct_index') is null or (q->>'correct_index') !~ '^-?[0-9]+$' then
        v_err := 'correct_index must be an integer';
      elsif (q->>'correct_index')::int < 0
            or (q->>'correct_index')::int > jsonb_array_length(q->'options') - 1 then
        v_err := 'correct_index out of range';
      elsif (q ? 'difficulty') and (q->>'difficulty') is not null
            and ((q->>'difficulty') !~ '^-?[0-9]+$'
                 or (q->>'difficulty')::int < 1 or (q->>'difficulty')::int > 5) then
        v_err := 'difficulty must be between 1 and 5';
      else
        v_err := null;
      end if;

      if v_err is not null then
        v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', v_err);
        continue;
      end if;

      -- Resolve the passage lazily on the first VALID question of the group,
      -- so a fully-invalid group never leaves an orphan passage.
      if not v_passage_resolved then
        if v_refs_passage then
          if v_in_passage_id is not null then
            v_resolved_pid := v_in_passage_id;
            if v_passage_text is not null then
              update passages set body = v_passage_text where id = v_in_passage_id;
            end if;
          else
            insert into passages (section, body)
            values (v_section::cat_section, v_passage_text)
            returning id into v_resolved_pid;
          end if;
        else
          v_resolved_pid := null;
        end if;
        v_passage_resolved := true;
      end if;

      if (q ? 'id') and nullif(q->>'id', '') is not null then
        update questions set
          section       = v_section::cat_section,
          difficulty    = coalesce((q->>'difficulty')::smallint, 3),
          body          = q->>'body',
          options       = q->'options',
          correct_index = (q->>'correct_index')::smallint,
          explanation   = q->>'explanation',
          duration_ms   = case when (q->>'duration_ms') ~ '^-?[0-9]+$'
                               then (q->>'duration_ms')::int else null end,
          passage_id    = v_resolved_pid
        where id = (q->>'id')::uuid;
        if found then
          v_updated := v_updated + 1;
        else
          v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', 'question id not found');
        end if;
      else
        insert into questions (section, difficulty, body, options, correct_index,
                               explanation, duration_ms, passage_id)
        values (
          v_section::cat_section,
          coalesce((q->>'difficulty')::smallint, 3),
          q->>'body',
          q->'options',
          (q->>'correct_index')::smallint,
          q->>'explanation',
          case when (q->>'duration_ms') ~ '^-?[0-9]+$' then (q->>'duration_ms')::int else null end,
          v_resolved_pid
        );
        v_inserted := v_inserted + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'errors', v_errors);
end;
$$;

revoke execute on function admin_upsert_questions(jsonb) from public, anon;
grant  execute on function admin_upsert_questions(jsonb) to authenticated, service_role;

-- ── b) admin_list_questions(p_section, p_active) -> table ────────────────────
create or replace function admin_list_questions(
  p_section text default null,
  p_active  boolean default null
)
returns table (
  id                uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  correct_index     smallint,
  difficulty        smallint,
  explanation       text,
  is_active         boolean,
  passage_id        uuid,
  passage_body      text,
  passage_is_active boolean,
  created_at        timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  return query
    select q.id, q.section, q.body, q.options, q.correct_index, q.difficulty,
           q.explanation, q.is_active, q.passage_id, p.body, p.is_active, q.created_at
    from questions q
    left join passages p on p.id = q.passage_id
    where (p_section is null or q.section = p_section::cat_section)
      and (p_active  is null or q.is_active = p_active)
    order by q.section, q.passage_id nulls last, q.created_at;
end;
$$;

revoke execute on function admin_list_questions(text, boolean) from public, anon;
grant  execute on function admin_list_questions(text, boolean) to authenticated, service_role;

-- ── c) admin_set_question_active(p_id, p_active) -> void ─────────────────────
create or replace function admin_set_question_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;
  update questions set is_active = p_active where id = p_id;
end;
$$;

revoke execute on function admin_set_question_active(uuid, boolean) from public, anon;
grant  execute on function admin_set_question_active(uuid, boolean) to authenticated, service_role;

-- ── d) admin_set_passage_active(p_id, p_active) -> void ──────────────────────
-- Independent switch: does NOT cascade to sub-questions.
create or replace function admin_set_passage_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;
  update passages set is_active = p_active where id = p_id;
end;
$$;

revoke execute on function admin_set_passage_active(uuid, boolean) from public, anon;
grant  execute on function admin_set_passage_active(uuid, boolean) to authenticated, service_role;
