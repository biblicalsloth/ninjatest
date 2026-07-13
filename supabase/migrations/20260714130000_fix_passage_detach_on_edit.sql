-- ─────────────────────────────────────────────────────────
-- Fix: admin_upsert_questions detached passage sub-questions on edit.
--
-- The UPDATE branch set passage_id = v_resolved_pid unconditionally. When an
-- admin edits an existing question by id WITHOUT re-supplying its passage,
-- v_refs_passage is false → v_resolved_pid is NULL → the edit wiped passage_id,
-- orphaning the sub-question (renders with no passage, and can drop the group
-- below pick_section_question_ids' >=3-active threshold, removing it from play).
--
-- 20260713050000 had fixed this ("passage_id = case when v_refs_passage ...");
-- 20260713100000 recreated the function from the pre-fix 20260713020000 copy
-- and silently reverted it (classic stale-copy regression). 20260713110000
-- inherited the broken version. This restores the guard on the latest def.
--
-- Recreated verbatim from 20260713110000 with ONE line changed (passage_id
-- on UPDATE). CREATE OR REPLACE keeps grants; no drop needed.
-- ─────────────────────────────────────────────────────────
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
  v_passage_image    text;
  v_in_passage_id    uuid;
  v_existing_section text;
  v_refs_passage     boolean;
  v_passage_error    text;
  v_passage_resolved boolean;
  v_resolved_pid     uuid;
  v_err              text;
  v_img              text;
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  for grp in select jsonb_array_elements(coalesce(payload, '[]'::jsonb)) loop
    -- ── group-level setup ──
    v_section        := grp->>'section';
    v_section_ok     := v_section in ('VARC', 'DILR', 'QUANT');
    v_passage_text   := grp->>'passage';                         -- null if absent/json-null
    v_passage_image  := nullif(grp->>'passage_image_url', '');
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

    if v_passage_error is null and v_passage_text is not null and length(v_passage_text) > 20000 then
      v_passage_error := 'passage too long (max 20000 chars)';
    end if;
    if v_passage_error is null and v_passage_image is not null and v_passage_image !~ '^https://' then
      v_passage_error := 'passage_image_url must be an https URL';
    end if;

    -- ── per-question ──
    for q in select jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb)) loop
      n_row := n_row + 1;
      v_img := nullif(q->>'image_url', '');

      if v_passage_error is not null then
        v_err := v_passage_error;
      elsif coalesce(btrim(q->>'body'), '') = '' then
        v_err := 'body is empty or blank';
      elsif length(q->>'body') > 8000 then
        v_err := 'body too long (max 8000 chars)';
      elsif jsonb_typeof(q->'options') is distinct from 'array'
            or coalesce(jsonb_array_length(q->'options'), 0) = 0 then
        v_err := 'options must be a non-empty array';
      elsif exists (select 1 from jsonb_array_elements(q->'options') e where jsonb_typeof(e) <> 'string') then
        v_err := 'options must all be strings';
      elsif exists (select 1 from jsonb_array_elements_text(q->'options') e where length(e) > 1000) then
        v_err := 'option too long (max 1000 chars)';
      elsif q->>'explanation' is not null and length(q->>'explanation') > 4000 then
        v_err := 'explanation too long (max 4000 chars)';
      elsif v_img is not null and v_img !~ '^https://' then
        v_err := 'image_url must be an https URL';
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
            if v_passage_text is not null or v_passage_image is not null then
              update passages set
                body      = coalesce(v_passage_text, body),
                image_url = coalesce(v_passage_image, image_url)
              where id = v_in_passage_id;
            end if;
          else
            insert into passages (section, body, image_url)
            values (v_section::cat_section, v_passage_text, v_passage_image)
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
          image_url     = v_img,
          duration_ms   = case when (q->>'duration_ms') ~ '^[0-9]+$'
                                 and (q->>'duration_ms')::int > 0
                               then (q->>'duration_ms')::int else null end,
          -- Guard: only re-point the passage when the upload actually carried
          -- passage fields. Editing a question without them keeps its passage.
          passage_id    = case when v_refs_passage then v_resolved_pid else passage_id end
        where id = (q->>'id')::uuid;
        if found then
          v_updated := v_updated + 1;
        else
          v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', 'question id not found');
        end if;
      else
        insert into questions (section, difficulty, body, options, correct_index,
                               explanation, image_url, duration_ms, passage_id)
        values (
          v_section::cat_section,
          coalesce((q->>'difficulty')::smallint, 3),
          q->>'body',
          q->'options',
          (q->>'correct_index')::smallint,
          q->>'explanation',
          v_img,
          case when (q->>'duration_ms') ~ '^[0-9]+$' and (q->>'duration_ms')::int > 0
               then (q->>'duration_ms')::int else null end,
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
