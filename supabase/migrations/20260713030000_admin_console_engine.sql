-- =========================================================
-- Admin question-upload console: engine edits
--   1. pick_section_question_ids() — passage-aware per-section selection
--   2. try_match_internal / accept_challenge — use it in every live builder
--   3. get_match_question / get_answer_reveal — expose the shared passage body
-- =========================================================

-- ── 1. Passage-aware per-section picker (internal-only) ──────────────────────
-- Returns the 3 question ids for one section, in intended order:
--   QUANT      -> unchanged: 3 random standalone-or-any active questions.
--   VARC/DILR  -> prefer ONE random active passage with >=3 active
--                 sub-questions, take 3 in passage order (created_at). If no
--                 such passage, fall back to 3 random active STANDALONE
--                 questions (passage_id is null), as before.
-- Returns NULL if the pool is empty (callers coalesce to '{}', preserving the
-- pre-existing "fewer than 9 ids when a section is empty" behavior).
create or replace function pick_section_question_ids(p_section cat_section)
returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_ids  uuid[];
  v_pid  uuid;
begin
  if p_section = 'QUANT' then
    select array_agg(id) into v_ids from (
      select id from questions
      where section = p_section and is_active
      order by random() limit 3
    ) s;
    return v_ids;
  end if;

  -- VARC / DILR: try a passage group first.
  select p.id into v_pid
  from passages p
  where p.section = p_section
    and p.is_active
    and (select count(*) from questions q where q.passage_id = p.id and q.is_active) >= 3
  order by random()
  limit 1;

  if v_pid is not null then
    select array_agg(id order by created_at) into v_ids from (
      select id, created_at from questions
      where passage_id = v_pid and is_active
      order by created_at limit 3
    ) s;
    return v_ids;
  end if;

  -- Fallback: standalone questions only.
  select array_agg(id) into v_ids from (
    select id from questions
    where section = p_section and is_active and passage_id is null
    order by random() limit 3
  ) s;
  return v_ids;
end;
$$;

-- Internal helper: only called from other SECURITY DEFINER builders (which run
-- as the owner), never directly by clients. Mirrors the try_match lockdown.
revoke execute on function pick_section_question_ids(cat_section) from public, anon, authenticated;

-- ── 2a. try_match_internal — same as 20260625020951, passage-aware picks ─────
-- (search_path restated inline: create-or-replace drops the pin applied by the
--  blanket ALTER in 20260627000000_pin_function_search_path.sql.)
create or replace function try_match_internal(p_user_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  select * into me
  from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  my_band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  q_ids := coalesce(pick_section_question_ids('VARC'),  '{}')
        || coalesce(pick_section_question_ids('DILR'),  '{}')
        || coalesce(pick_section_question_ids('QUANT'), '{}');

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids, me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

-- ── 2b. accept_challenge — same as 20260702000100; passage-aware only for the
--        mixed 3-3-3 mode. Single-section mode (9 from one section) unchanged.
create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  if ch.section_mode is null then
    q_ids := coalesce(pick_section_question_ids('VARC'),  '{}')
          || coalesce(pick_section_question_ids('DILR'),  '{}')
          || coalesce(pick_section_question_ids('QUANT'), '{}');
  else
    select array_agg(id) into q_ids from (
      select id from questions where section = ch.section_mode and is_active order by random() limit 9
    ) s;
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;

-- ── 3a. get_match_question — same as 20260702000550 + shared passage body ────
-- correct_index/explanation stay stripped. `passage` = passages.body when the
-- question belongs to a passage group, else null.
-- Adding the `passage` OUT param changes the return type, so drop+recreate
-- (create-or-replace can't change return type) and re-apply the grants.
drop function if exists get_match_question(uuid, smallint);
create function get_match_question(p_match_id uuid, p_index smallint)
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
  m   matches%rowtype;
  q   questions%rowtype;
  cfg section_config%rowtype;
  v_passage text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id,
    q.section,
    q.body,
    q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at,
    v_passage;
end;
$$;

revoke execute on function get_match_question(uuid, smallint) from public, anon;
grant  execute on function get_match_question(uuid, smallint) to authenticated, service_role;

-- ── 3b. get_answer_reveal — same as 20260623033126 + shared passage body ─────
-- NOTE: search_path pin restated inline; drop+recreate because the new
-- `passage` OUT param changes the return type.
drop function if exists get_answer_reveal(uuid, smallint);
create function get_answer_reveal(p_match_id uuid, p_index smallint)
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
  m matches%rowtype;
  q questions%rowtype;
  v_passage text;
begin
  select * into m from matches where id = p_match_id;

  if auth.uid() not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  -- Only reveal once the question has closed
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query
    select
      q.correct_index,
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

revoke execute on function get_answer_reveal(uuid, smallint) from public, anon;
grant  execute on function get_answer_reveal(uuid, smallint) to authenticated, service_role;
