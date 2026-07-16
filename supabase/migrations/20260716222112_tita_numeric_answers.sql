-- ─────────────────────────────────────────────────────────
-- TITA answers are numeric. Enforce it, so the answer box can safely refuse
-- everything else.
--
-- WHY. Probed tita_matches against a real user's likely inputs (2026-07-17):
--   accepted: 1900 · " 1900 " · 1,900 · 1900.0 · 01900 · +1900 · 1.9e3
--   REJECTED: Rs.1900 · 1900m · "1900 metres" · "one thousand nine hundred"
-- So a player who solves correctly and types the unit the question asked for
-- ("...by how many metres?") is marked WRONG. Right solve, zero points.
--
-- The tempting fix — loosen tita_matches to strip units — is a trap:
--   * "Rs.1900" with non-numerics stripped becomes ".1900" = 0.19, so stripping
--     INVENTS a wrong answer out of a right intent rather than rescuing it.
--   * stripping "-" makes "-3" match a key of "3". A loosened matcher marks
--     wrong answers RIGHT, which is worse than the bug it fixes.
-- So the matcher stays strict and the fix moves to the input: make a unit
-- impossible to type (this is exactly what the real CAT interface does — a
-- numeric keypad), and guarantee the key is numeric so that rule can never be
-- wrong.
--
-- WHAT. This constraint is the load-bearing half. The 52 live TITA rows were
-- written by an ingest script through service_role, NOT through
-- admin_upsert_questions — so validating only in the RPC would leave the actual
-- writer unchecked. A table constraint binds every writer, present and future.
-- Verified against the live bank before adding: 52/52 rows already satisfy it.
--
-- Supersedes questions_tita_needs_answer (20260716212156), which only required
-- non-null. Non-null was never sufficient: "Rs.1900" is non-null and equally
-- unanswerable from a numeric-only box.
--
-- The regex is deliberately about SHAPE, not arithmetic — it rejects letters,
-- currency and units. tita_matches still does the real comparison by casting to
-- numeric, so a pathological-but-letterless key like "1,,,2" would pass here and
-- simply fail to match; that is the matcher's job, not the constraint's.
-- ─────────────────────────────────────────────────────────

alter table questions drop constraint if exists questions_tita_needs_answer;
alter table questions drop constraint if exists questions_tita_answer_numeric;
alter table questions add constraint questions_tita_answer_numeric
  check (
    qtype <> 'tita'
    or (
      answer_value is not null
      and (
        -- grouped thousands: 1,234  /  bare or decimal: 8, 0.5, -3, .5
        answer_value ~ '^[+-]?[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$'
        or answer_value ~ '^[+-]?[0-9]*\.?[0-9]+$'
      )
    )
  );

-- ── admin_upsert_questions: same rule at the console door ──
-- Recreated from its LATEST definition (20260716212156); only the TITA
-- answer_value validation changes.
create or replace function admin_upsert_questions(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
  v_qtype            text;
  v_answer           text;
  v_is_tita          boolean;
  v_difficulty       smallint;
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  for grp in select jsonb_array_elements(coalesce(payload, '[]'::jsonb)) loop
    v_section        := grp->>'section';
    v_section_ok     := v_section in ('VARC', 'DILR', 'QUANT');
    v_passage_text   := grp->>'passage';
    v_passage_image  := nullif(grp->>'passage_image_url', '');
    v_in_passage_id  := nullif(grp->>'passage_id', '')::uuid;
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

    for q in select jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb)) loop
      n_row := n_row + 1;
      v_img     := nullif(q->>'image_url', '');
      v_qtype   := lower(coalesce(nullif(btrim(q->>'qtype'), ''), 'mcq'));
      v_is_tita := (v_qtype = 'tita');
      v_answer  := nullif(btrim(coalesce(q->>'answer_value', '')), '');

      if v_passage_error is not null then
        v_err := v_passage_error;
      elsif v_qtype not in ('mcq', 'tita') then
        v_err := 'qtype must be mcq or tita';
      elsif coalesce(btrim(q->>'body'), '') = '' then
        v_err := 'body is empty or blank';
      elsif length(q->>'body') > 8000 then
        v_err := 'body too long (max 8000 chars)';
      elsif q->>'explanation' is not null and length(q->>'explanation') > 4000 then
        v_err := 'explanation too long (max 4000 chars)';
      elsif v_img is not null and v_img !~ '^https://' then
        v_err := 'image_url must be an https URL';
      elsif (q ? 'difficulty') and (q->>'difficulty') is not null
            and ((q->>'difficulty') !~ '^-?[0-9]+$'
                 or (q->>'difficulty')::int < 1 or (q->>'difficulty')::int > 5) then
        v_err := 'difficulty must be between 1 and 5';
      elsif v_is_tita then
        if v_answer is null then
          v_err := 'tita requires a non-empty answer_value';
        elsif length(v_answer) > 200 then
          v_err := 'answer_value too long (max 200 chars)';
        elsif not (v_answer ~ '^[+-]?[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$'
                or v_answer ~ '^[+-]?[0-9]*\.?[0-9]+$') then
          -- The answer box only accepts digits, so a key carrying a unit or
          -- currency ("Rs.1900", "1900 metres") could never be matched by anyone.
          v_err := 'answer_value must be numeric — no units, currency or words (e.g. 1900, not "Rs.1900")';
        else
          v_err := null;
        end if;
      elsif jsonb_typeof(q->'options') is distinct from 'array'
            or coalesce(jsonb_array_length(q->'options'), 0) = 0 then
        v_err := 'options must be a non-empty array';
      elsif exists (select 1 from jsonb_array_elements(q->'options') e where jsonb_typeof(e) <> 'string') then
        v_err := 'options must all be strings';
      elsif exists (select 1 from jsonb_array_elements_text(q->'options') e where length(e) > 1000) then
        v_err := 'option too long (max 1000 chars)';
      elsif (q->>'correct_index') is null or (q->>'correct_index') !~ '^-?[0-9]+$' then
        v_err := 'correct_index must be an integer';
      elsif (q->>'correct_index')::int < 0
            or (q->>'correct_index')::int > jsonb_array_length(q->'options') - 1 then
        v_err := 'correct_index out of range';
      else
        v_err := null;
      end if;

      if v_err is not null then
        v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', v_err);
        continue;
      end if;

      v_difficulty := coalesce((q->>'difficulty')::smallint, 3);

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
        -- elo is deliberately NOT touched on update: it is learned by
        -- submit_answer, and an admin body edit must not reset it.
        update questions set
          section       = v_section::cat_section,
          difficulty    = v_difficulty,
          body          = q->>'body',
          qtype         = v_qtype,
          options       = case when v_is_tita then '[]'::jsonb else q->'options' end,
          correct_index = case when v_is_tita then 0::smallint
                               else (q->>'correct_index')::smallint end,
          answer_value  = case when v_is_tita then v_answer else null end,
          explanation   = q->>'explanation',
          image_url     = v_img,
          duration_ms   = case when (q->>'duration_ms') ~ '^[0-9]+$'
                                 and (q->>'duration_ms')::int > 0
                               then (q->>'duration_ms')::int else null end,
          passage_id    = case when v_refs_passage then v_resolved_pid else passage_id end
        where id = (q->>'id')::uuid;
        if found then
          v_updated := v_updated + 1;
        else
          v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', 'question id not found');
        end if;
      else
        insert into questions (section, difficulty, body, qtype, options, correct_index,
                               answer_value, explanation, image_url, duration_ms, passage_id, elo)
        values (
          v_section::cat_section,
          v_difficulty,
          q->>'body',
          v_qtype,
          case when v_is_tita then '[]'::jsonb else q->'options' end,
          case when v_is_tita then 0::smallint else (q->>'correct_index')::smallint end,
          case when v_is_tita then v_answer else null end,
          q->>'explanation',
          v_img,
          case when (q->>'duration_ms') ~ '^[0-9]+$' and (q->>'duration_ms')::int > 0
               then (q->>'duration_ms')::int else null end,
          v_resolved_pid,
          least(2800, greatest(400,
            1000 + v_difficulty * 100 + case when v_is_tita then 100 else 0 end))
        );
        v_inserted := v_inserted + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'errors', v_errors);
end; $$;

revoke all on function admin_upsert_questions(jsonb) from public, anon;
grant execute on function admin_upsert_questions(jsonb) to authenticated, service_role;
