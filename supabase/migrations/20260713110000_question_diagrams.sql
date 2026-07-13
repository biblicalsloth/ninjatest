-- =========================================================
-- Question diagrams / images + spectator passage fix
--
-- Adds one optional image per question stem and per passage, served
-- to players, spectators, and the reveal screen (reveal reuses the
-- live get_match_question payload, so no change there). Images live in
-- a public Storage bucket; only their https URL is stored on the row.
--
-- Also fixes the spectator gap: get_match_question_spectator never
-- returned the passage, so passage-group VARC/DILR questions were
-- unintelligible to spectators.
--
-- Migration discipline — each function recreated from its LATEST def:
--   admin_upsert_questions       <- 20260713100000 (keeps size caps + duration>0)
--   get_match_question           <- 20260713040000
--   get_match_question_spectator <- 20260713080000
-- option_perm is untouched.
-- =========================================================

alter table questions add column if not exists image_url text;
alter table passages  add column if not exists image_url text;

-- ── Storage bucket for diagrams (public read; admin-only writes) ──
insert into storage.buckets (id, name, public)
values ('question-assets', 'question-assets', true)
on conflict (id) do nothing;

-- No SELECT policy: a public bucket serves object URLs
-- (/storage/v1/object/public/…, which is what <img src> uses) without one.
-- A broad SELECT policy would only add the ability to LIST every filename —
-- unnecessary here and flagged by the storage linter (public_bucket_allows_listing).
drop policy if exists "qassets_public_read"  on storage.objects;
drop policy if exists "qassets_admin_insert" on storage.objects;
drop policy if exists "qassets_admin_update" on storage.objects;
drop policy if exists "qassets_admin_delete" on storage.objects;

create policy "qassets_admin_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'question-assets'
    and coalesce((select is_admin from profiles where id = (select auth.uid())), false)
  );

create policy "qassets_admin_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'question-assets'
    and coalesce((select is_admin from profiles where id = (select auth.uid())), false)
  );

create policy "qassets_admin_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'question-assets'
    and coalesce((select is_admin from profiles where id = (select auth.uid())), false)
  );

-- ─────────────────────────────────────────────────────────
-- admin_upsert_questions — accept optional https image_url (per
-- question) and passage_image_url (per group). URLs only; the upload
-- itself goes straight to Storage from the admin console. Recreated
-- from 20260713100000 with only the image additions.
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
          passage_id    = v_resolved_pid
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

-- ─────────────────────────────────────────────────────────
-- get_match_question — serve the stem image and passage image.
-- Recreated from 20260713040000; option_perm logic unchanged.
-- DROP first: adding return columns changes the OUT-param row type, which
-- CREATE OR REPLACE rejects. The drop clears grants (incl. the anon revoke
-- from 20260627000200), so both are re-established below.
-- ─────────────────────────────────────────────────────────
drop function if exists get_match_question(uuid, smallint);
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  cap_ms            integer,
  started_at        timestamptz,
  passage           text,
  image_url         text,
  passage_image_url text
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
  v_pimage  text;
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
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id,
    q.section,
    q.body,
    shuffled,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

revoke execute on function get_match_question(uuid, smallint) from public, anon;
grant  execute on function get_match_question(uuid, smallint) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────
-- get_match_question_spectator — now returns the passage (bug fix)
-- plus both images. Options stay CANONICAL (participants are excluded,
-- so canonical order leaks nothing and spectators need no per-player
-- shuffle). Recreated from 20260713080000.
-- DROP first (return-type change) — see get_match_question note above;
-- grants re-established below.
-- ─────────────────────────────────────────────────────────
drop function if exists get_match_question_spectator(uuid, smallint);
create or replace function get_match_question_spectator(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  cap_ms            integer,
  started_at        timestamptz,
  passage           text,
  image_url         text,
  passage_image_url text
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  cfg       section_config%rowtype;
  v_passage text;
  v_pimage  text;
begin
  select * into m from matches where id = p_match_id;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if auth.uid() in (m.player_a, m.player_b) then
    raise exception 'participants must use get_match_question';
  end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id, q.section, q.body, q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

revoke execute on function get_match_question_spectator(uuid, smallint) from public, anon;
grant  execute on function get_match_question_spectator(uuid, smallint) to authenticated, service_role;
