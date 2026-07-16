-- ─────────────────────────────────────────────────────────
-- TITA: seed calibration + the three surfaces that never learned about it.
--
-- 20260716130000 shipped TITA through the MATCH flow and 20260716201821 taught
-- the Ninja read paths about it. Everything else still assumes MCQ. This closes
-- the rest and fixes the seed ELO scale.
--
-- 1. SEED ELO IS ON THE WRONG SCALE. Every questions.elo is the one-time seed
--    from 20260713000000 (1000 + difficulty*100); no question has ever been
--    served (sum(times_seen) = 0 bank-wide), so the submit_answer nudge has
--    never run and every ELO is still that guess. The scale was built for MCQ,
--    where a blind guess lands 1/n_opts of the time. TITA has no options and no
--    guess floor, so identical content yields a strictly lower p(correct) and
--    therefore a higher true ELO.
--
--    Sizing it, using submit_answer's own model. Steady state is where
--    E[res_q] = the question's expectation. With res_q = 1.0 on wrong and
--    ~0.35*(t/cap) on correct, E[res_q] ~= 1 - 0.8*p_correct. Solving
--    1 - 0.8p = 1/(1 + 10^(-g/400)) for the gap g = q.elo - player_elo:
--        g(p) = -400 * log10( 0.8p / (1 - 0.8p) )
--    For 4-option MCQ, p_correct = 0.25 + 0.75*p_know; for TITA, p_correct =
--    p_know. The TITA-minus-MCQ gap at equal content:
--        p_know = 0.25 -> 241 - 108 = +133
--        p_know = 0.50 ->  70 -   0 = + 70
--        p_know = 0.75 -> -70 - -108 = + 37
--    The gap widens with difficulty. These 52 seed at 1200-1500 (difficulty
--    2-5, i.e. mid-to-hard), so +100 is the honest middle. It is a better
--    starting guess than the MCQ scale, NOT a measurement — the nudge still has
--    to do the real work over ~20 serves each once traffic exists.
--
--    Guarded on times_seen = 0 so this only ever rewrites an untouched seed and
--    can never stomp a learned ELO.
--
-- 2. PRACTICE COULD DEAL AN UNANSWERABLE QUESTION. start_practice filtered only
--    on section + is_active, so a TITA could land in a practice session, where
--    get_practice_question returns options (TITA's is '[]') with no qtype and
--    submit_practice_answer only accepts p_selected. Result: no options render
--    and every submit scores wrong. /practice is live and linked from the lobby.
--    Excluded TITA from practice rather than plumbing qtype through the practice
--    RPCs + client — see the ponytail note at the filter.
--
-- 3. START_PRACTICE MISCOUNTED TITA AS A SKIP. Its weakest-section accuracy read
--    filtered on `a.selected_index is not null`, the MCQ skip notion. TITA
--    answers keep selected_index null and carry answer_text, so every TITA
--    attempt from a real match was dropped from the accuracy that orders the
--    practice mix. Moved to the canonical notion established by 20260716130000
--    and used by submit_answer/get_debrief_data: skip = both columns null.
--
-- 4. ADMIN WAS TITA-BLIND IN BOTH DIRECTIONS. admin_list_questions never
--    returned qtype/answer_value even though admin-client.tsx already declares
--    both and forwards them to /api/ninja/audit — they arrived undefined, so the
--    auditor coerced every TITA to MCQ and judged it against a blank key with no
--    options (the same failure 20260716201821 fixed for the ask path).
--    admin_upsert_questions hard-required a non-empty options array and an
--    in-range correct_index and never wrote qtype/answer_value, so TITA rows
--    could be neither created nor edited through the console.
--
-- 5. ELO WAS NOT SEEDED ON INSERT AT ALL. The 1000 + difficulty*100 rule was a
--    one-time UPDATE, never a default; questions.elo defaults to a flat 1200. So
--    every question added via /admin since 20260713000000 has ignored its own
--    difficulty. admin_upsert_questions now applies the rule (plus the TITA
--    offset) on INSERT only — never on UPDATE, which would stomp a learned ELO.
--
-- Bodies recreated from their LATEST live definitions per CLAUDE.md migration
-- discipline; only the TITA/elo branches are added. search_path pinned inline,
-- grants re-applied after each drop.
-- ─────────────────────────────────────────────────────────

-- ── 1. Reseed the untouched TITA rows onto their own scale ──
update questions
   set elo = least(2800, elo + 100)
 where qtype = 'tita'
   and times_seen = 0;

-- ── A TITA with no answer_value is permanently unscoreable ──
-- tita_matches(input, null) returns false for every input, so such a row can
-- never be answered correctly by anyone. Enforce at the table: it is one line
-- here and it binds every writer forever, including future ones.
alter table questions drop constraint if exists questions_tita_needs_answer;
alter table questions add constraint questions_tita_needs_answer
  check (qtype <> 'tita' or answer_value is not null);

-- ── 2 + 3. start_practice: MCQ-only, and count TITA answers honestly ──
create or replace function start_practice()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid         uuid := (select auth.uid());
  today_count int;
  player_elo  int;
  ordered     text[];
  wanted      int[] := array[5, 3, 1];
  ids         uuid[] := '{}';
  sec_ids     uuid[];
  i           int;
  sid         uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('start_practice', 5, 60);

  select count(*) into today_count
  from practice_sessions
  where user_id = uid and created_at >= date_trunc('day', now());
  if today_count >= 5 then
    raise exception 'daily practice limit reached';
  end if;

  select elo into player_elo from profiles where id = uid;

  -- Sections ordered weakest-first by the caller's real accuracy; sections
  -- with <5 real answers count as neutral 0.5 so newcomers get 3/3/3-ish.
  -- Skip = selected_index AND answer_text both null (the canonical notion from
  -- 20260716130000). The old `selected_index is not null` test silently dropped
  -- every TITA attempt, since TITA never sets selected_index.
  select array_agg(s.sec order by s.acc asc, s.sec) into ordered
  from (
    select sec.sec,
           coalesce((
             select case when count(*) >= 5
                         then avg(case when a.is_correct then 1.0 else 0.0 end) end
             from match_answers a
             join questions q on q.id = a.question_id
             where a.user_id = uid
               and not (a.selected_index is null and a.answer_text is null)
               and q.section = sec.sec::cat_section
           ), 0.5) as acc
    from (values ('VARC'), ('DILR'), ('QUANT')) sec(sec)
  ) s;

  for i in 1..3 loop
    select array_agg(t.id) into sec_ids
    from (
      select q.id
      from questions q
      -- ponytail: practice is MCQ-only. get_practice_question returns no qtype
      -- and submit_practice_answer takes only p_selected, so a TITA here is
      -- unanswerable. Excluding is one line; making practice TITA-aware means a
      -- new return column, a new RPC arg, and a typed-answer input in
      -- practice-client.tsx. Do that when practice needs to drill TITA.
      where q.section = ordered[i]::cat_section and q.is_active
        and q.qtype = 'mcq'
      order by abs(q.elo - (player_elo + (random() * 300 - 150)::int)), random()
      limit wanted[i]
    ) t;
    ids := ids || coalesce(sec_ids, '{}');
  end loop;

  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'no practice questions available';
  end if;

  insert into practice_sessions (user_id, question_ids)
  values (uid, ids)
  returning id into sid;

  return jsonb_build_object('session_id', sid, 'total', array_length(ids, 1));
end; $$;

revoke all on function start_practice() from public, anon;
grant execute on function start_practice() to authenticated, service_role;

-- ── 4a. admin_list_questions: return qtype + answer_value ──
-- Return type changes → drop + recreate.
drop function if exists admin_list_questions(text, boolean);
create function admin_list_questions(p_section text default null, p_active boolean default null)
returns table (
  id uuid, section cat_section, body text, options jsonb, correct_index smallint,
  difficulty smallint, explanation text, is_active boolean, passage_id uuid,
  passage_body text, passage_is_active boolean, created_at timestamptz,
  qtype text, answer_value text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  return query
    select q.id, q.section, q.body, q.options, q.correct_index, q.difficulty,
           q.explanation, q.is_active, q.passage_id, p.body, p.is_active, q.created_at,
           q.qtype, q.answer_value
    from questions q
    left join passages p on p.id = q.passage_id
    where (p_section is null or q.section = p_section::cat_section)
      and (p_active  is null or q.is_active = p_active)
    order by q.section, q.passage_id nulls last, q.created_at;
end; $$;

revoke all on function admin_list_questions(text, boolean) from public, anon;
grant execute on function admin_list_questions(text, boolean) to authenticated, service_role;

-- ── 4b + 5. admin_upsert_questions: accept TITA, and seed elo on insert ──
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

      -- Shared validation, then the branch that differs: MCQ is scored by
      -- correct_index into options; TITA is scored by tita_matches against
      -- answer_value and carries neither.
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
        elsif tita_norm(v_answer) is null then
          -- Normalises to nothing (e.g. all whitespace/commas), so tita_matches
          -- could never match it. Reject rather than store an unscoreable row.
          v_err := 'answer_value normalises to empty';
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
          -- Seed the rule that 20260713000000 only ever applied once, plus the
          -- TITA offset derived in this file's header. Clamped to submit_answer's
          -- own [400, 2800] range.
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
