-- =========================================================
-- Audit round 3 — fixes from the sector bug-hunt
--
-- Recreates each function from its LATEST prior definition
-- (migration discipline: never CREATE OR REPLACE from a stale copy):
--   get_leaderboard        <- 20260624092649
--   admin_upsert_questions <- 20260713020000
--   forfeit_match          <- 20260713090000
-- Plus a table-grant lockdown on matchmaking_queue.
-- =========================================================

-- ─────────────────────────────────────────────────────────
-- 1. CRITICAL — matchmaking_queue was directly client-writable.
--    The `queue_self` RLS policy is FOR ALL and no migration ever
--    revoked table INSERT/UPDATE/DELETE from `authenticated`, so a
--    client could UPDATE its own `elo`/`enqueued_at` — the exact
--    columns try_match_internal trusts for band + pairing distance —
--    or INSERT a waiting row bypassing join_queue's live-match guard
--    and rate limit. All legitimate writes go through SECURITY DEFINER
--    RPCs (join_queue / leave_queue / queue_heartbeat), which run as
--    the table owner and are unaffected. The client only ever SELECTs
--    this table (app/queue/page.tsx), and realtime postgres_changes
--    needs SELECT — so keep read, drop write. Mirrors the definer-only
--    posture of friendships / match_events.
-- ─────────────────────────────────────────────────────────
revoke insert, update, delete on public.matchmaking_queue from authenticated, anon;

drop policy if exists queue_self on public.matchmaking_queue;
create policy queue_self_read on public.matchmaking_queue
  for select to public
  using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────
-- 2. get_leaderboard — stable tiebreaker (equal-ELO rows ordered
--    nondeterministically caused page-boundary dupes/drops under
--    offset pagination) + clamp p_limit/p_offset (anon-callable; a
--    2^31 limit forced a full-table window scan).
-- ─────────────────────────────────────────────────────────
create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (
  rank         bigint,
  username     text,
  display_name text,
  elo          int,
  wins         int,
  losses       int,
  draws        int,
  avatar_url   text
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    rank() over (order by elo desc, wins desc, username asc),
    username,
    display_name,
    elo,
    wins,
    losses,
    draws,
    avatar_url
  from profiles
  order by elo desc, wins desc, username asc
  limit  least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ─────────────────────────────────────────────────────────
-- 3. admin_upsert_questions — reject non-positive duration_ms
--    (a cap <= 0 makes every submission instantly "late" → the
--    question is unanswerable, and a negative cap deflates the FULL
--    margin in finalize_match), and cap text field sizes so a pasted
--    base64 blob can't bloat every get_match_question / admin_list
--    payload. Recreated verbatim from 20260713020000 with only these
--    validation additions + the two duration_ms case expressions.
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

    if v_passage_error is null and v_passage_text is not null and length(v_passage_text) > 20000 then
      v_passage_error := 'passage too long (max 20000 chars)';
    end if;

    -- ── per-question ──
    for q in select jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb)) loop
      n_row := n_row + 1;

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
                               explanation, duration_ms, passage_id)
        values (
          v_section::cat_section,
          coalesce((q->>'difficulty')::smallint, 3),
          q->>'body',
          q->'options',
          (q->>'correct_index')::smallint,
          q->>'explanation',
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
-- 4. forfeit_match — no-skill parity with finalize_match. finalize's
--    L3 fix records winner_id = NULL for a zero-skill match ("no skill
--    signal shouldn't render as a win"); the no-skill FORFEIT branch
--    still stamped winner_id = present_player, so it surfaced as a W/L
--    in get_profile_matches / get_recent_matches while the profile
--    win/loss counters stayed untouched — history drifted from stats.
--    Recreated verbatim from 20260713090000 with the single winner_id
--    change in the no-skill branch.
-- ─────────────────────────────────────────────────────────
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  cap             integer;
  prev_absent     boolean;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  quitter := case when present_player = m.player_a then m.player_b else m.player_a end;

  -- A submission (even a skip) always records time_taken_ms; only the cron's
  -- skip rows have a NULL time. Such a row on the quitter's PREVIOUS question
  -- is proof they already missed a full deadline — no need to wait out the
  -- current one again.
  prev_absent := m.current_index > 0 and exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = m.current_index - 1
      and selected_index is null and time_taken_ms is null
  );

  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = m.current_index
      and (selected_index is not null or time_taken_ms is not null)
  ) then
    raise exception 'opponent answered — not absent';
  end if;

  if not prev_absent then
    select coalesce(q.duration_ms, sc.cap_ms) into cap
    from questions q
    join section_config sc on sc.section = q.section
    where q.id = m.question_ids[m.current_index + 1];

    -- fails closed: a NULL cap (question row missing) means 'too early'
    if m.question_started_at is null or cap is null
       or now() < m.question_started_at + ((cap + 5000)::text || ' milliseconds')::interval then
      raise exception 'too early to forfeit — opponent still within the question deadline';
    end if;
  end if;

  -- No-skill guard (parity with finalize_match): a rated match where nobody
  -- got anything right carries no signal — end it without transferring ELO,
  -- and record NO winner (matching finalize_match's L3 fix).
  if not m.is_rated
     or (m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0) then
    update matches set status='abandoned', ended_at=now(), winner_id=null
    where id = p_match_id;
    return;
  end if;

  perform apply_rated_result(p_match_id, present_player, quitter, 1.0);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- 5. queue_heartbeat — opportunistic re-pair. Two players calling
--    join_queue in the same instant each lock their own waiting row
--    and can't see the other's uncommitted INSERT (and SKIP LOCKED
--    skips a locked row), so neither pairs; the client never re-calls
--    try_match, so recovery waited on the per-minute rematch_waiting
--    cron (~60s worst case). The client already pings queue_heartbeat
--    every 20s — attempt a match there first so a stranded waiting
--    pair recovers in ~20s. try_match() matches the caller (auth.uid())
--    and no-ops when nothing is in band. If it pairs the caller, their
--    row flips to 'matched', the heartbeat update touches 0 rows and
--    returns false → client re-reads and routes into the match.
--    Recreated from 20260713090000 with the single try_match() call.
-- ─────────────────────────────────────────────────────────
create or replace function queue_heartbeat()
returns boolean language plpgsql security definer
set search_path = pg_catalog, public as $$
declare n int;
begin
  perform check_rate_limit('queue_heartbeat', 10, 10);
  perform try_match();
  update matchmaking_queue set heartbeat_at = now()
  where user_id = auth.uid() and status = 'waiting';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
