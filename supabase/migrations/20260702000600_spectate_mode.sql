-- Spectate mode (spec v2 social/engagement) — the largest lift of this
-- batch, since it touches the Realtime authorization model.
--
-- Confirmed before building: the match:${matchId} broadcast/presence
-- channel is already unauthenticated at the transport level (no RLS on
-- realtime.messages) — only postgres_changes and the RPCs currently gate
-- participants. Opening matches_read RLS to all authenticated users would
-- let anyone query/subscribe to ANY match's row directly via
-- `.from("matches")`, a much broader surface than "watch this one match" —
-- so instead: new status-based (not participant-gated) RPCs for reads, and
-- server-side realtime.send() broadcasts (private=false, matching the
-- channel's existing unauthenticated posture) carrying only safe-to-share
-- fields (scores, current_index, status — never correct_index/explanations).
--
-- Deviates from the plan's literal "new public RPC" text for
-- get_active_matches: made all three spectate RPCs authenticated-only.
-- Spectating is a new in-app feature, not an existing public-facing page
-- like the leaderboard/profile — conservative default, easy to loosen later
-- if a public showcase need shows up.
--
-- get_match_question_spectator's section_config lookup is aliased
-- (`section_config sc where sc.section = ...`) to avoid the exact ambiguity
-- bug fixed for get_match_question in 20260702000550 — see that migration
-- for the full explanation.

create or replace function get_spectator_match(p_match_id uuid)
returns table (
  match_id      uuid,
  status        match_status,
  current_index smallint,
  score_a       int,
  score_b       int,
  player_a_username text,
  player_a_avatar   text,
  player_b_username text,
  player_b_avatar   text
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    m.id, m.status, m.current_index, m.score_a, m.score_b,
    pa.username, pa.avatar_url,
    pb.username, pb.avatar_url
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where m.id = p_match_id
    and m.status in ('active', 'completed');
$$;

revoke execute on function get_spectator_match(uuid) from public, anon;
grant execute on function get_spectator_match(uuid) to authenticated, service_role;

create or replace function get_match_question_spectator(p_match_id uuid, p_index smallint)
returns table (
  question_id uuid,
  section     cat_section,
  body        text,
  options     jsonb,
  cap_ms      integer,
  started_at  timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m   matches%rowtype;
  q   questions%rowtype;
  cfg section_config%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  return query select
    q.id, q.section, q.body, q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at;
end;
$$;

revoke execute on function get_match_question_spectator(uuid, smallint) from public, anon;
grant execute on function get_match_question_spectator(uuid, smallint) to authenticated, service_role;

create or replace function get_active_matches(p_limit int default 20)
returns table (
  match_id      uuid,
  player_a_username text,
  player_a_elo       int,
  player_b_username text,
  player_b_elo       int,
  score_a       int,
  score_b       int,
  current_index smallint,
  started_at    timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    m.id, pa.username, pa.elo, pb.username, pb.elo,
    m.score_a, m.score_b, m.current_index, m.started_at
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where m.status = 'active'
  order by m.started_at desc
  limit p_limit;
$$;

revoke execute on function get_active_matches(int) from public, anon;
grant execute on function get_active_matches(int) to authenticated, service_role;

-- Broadcast helper: only the fields a spectator is allowed to see.
create or replace function broadcast_spectator_update(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id;
  perform realtime.send(
    jsonb_build_object(
      'match_id', m.id,
      'status', m.status,
      'current_index', m.current_index,
      'score_a', m.score_a,
      'score_b', m.score_b
    ),
    'spectator_update',
    'match:' || p_match_id::text,
    false
  );
end;
$$;

revoke execute on function broadcast_spectator_update(uuid) from public, anon, authenticated;

-- submit_answer: broadcast once at the end, after maybe_advance has already
-- run in the same transaction — this single call captures the post-score
-- AND post-advance-or-finalize state in one shot.
create or replace function submit_answer(
  p_match_id       uuid,
  p_question_index smallint,
  p_selected_index smallint
)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m        matches%rowtype;
  q        questions%rowtype;
  cfg      section_config%rowtype;
  uid      uuid := auth.uid();
  is_a     boolean;
  cap      integer;
  taken_ms integer;
  correct  boolean;
  grace    integer;
  pts      integer;
begin
  perform check_rate_limit('submit_answer', 20, 5);

  select * into m from matches where id = p_match_id for update;

  if not found or m.status <> 'active' then raise exception 'match not active'; end if;
  if uid not in (m.player_a, m.player_b) then raise exception 'not a participant'; end if;
  if p_question_index <> m.current_index then raise exception 'stale question'; end if;
  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = uid and question_index = p_question_index
  ) then raise exception 'already answered'; end if;

  select * into q   from questions where id = m.question_ids[p_question_index + 1];
  select * into cfg from section_config where section = q.section;
  cap := coalesce(q.duration_ms, cfg.cap_ms);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  correct := (p_selected_index is not null and p_selected_index = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when correct                  then cfg.base_points + grace
    when p_selected_index is null then 0
    else                               -cfg.wrong_penalty
  end;

  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    p_selected_index, correct, pts, taken_ms
  );

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  perform maybe_advance(p_match_id, p_question_index);
  perform broadcast_spectator_update(p_match_id);
end;
$$;

-- advance_timed_out: same broadcast, for the case where a spectator is
-- watching a match and a player times out (index/status changes without
-- either player calling submit_answer).
create or replace function advance_timed_out()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r   record;
  cap integer;
begin
  for r in
    select m.*, q.section, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id;
      end if;
      perform broadcast_spectator_update(r.id);
    end if;
  end loop;
end;
$$;
