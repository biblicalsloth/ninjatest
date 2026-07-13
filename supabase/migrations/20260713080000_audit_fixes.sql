-- =========================================================
-- Audit fixes (2026-07-13). Addresses findings from the ELO/match-pipeline
-- audit. Every function below is recreated from its LATEST prior definition
-- (migration discipline — never from a stale copy):
--   forfeit_match / submit_answer / finalize_match  ← 20260713060000_rating_current_elo_zero_sum
--   advance_timed_out                               ← 20260702000700_fix_advance_timed_out_regression
--   get_spectator_match / get_match_question_spectator ← 20260702000600_spectate_mode
--   get_profile_matches                             ← 20260624003427_public_profile_matches
--   get_recent_matches                              ← 20260623070438_fix_display_name_and_stale_matches
--   end_current_season                              ← 20260702000800_season_reset_rating_history
--   profiles_update policy                          ← 20260713000500_unify_admin_is_admin
--
-- Fixes:
--  C1 (CRITICAL) forfeit_match was a self-declared win button: any participant
--     could call it after 20s and be recorded the winner with the opponent
--     labelled the quitter, no server-verifiable proof of absence. Now forfeit
--     requires the opponent to have MISSED the current question's full deadline
--     (+5s network slack) with no answer row. A present client always writes a
--     row (auto-submit null at 0), so "no row past deadline" is reliable proof
--     of disconnect. A winning, present opponent always has a row → the trailing
--     player can no longer steal a win. ponytail: cap-latency forfeit (must wait
--     out the current question); upgrade to a per-player heartbeat column if a
--     faster forfeit is needed. The advance_timed_out cron remains the backstop.
--  H1 (HIGH) submit_answer clamped taken_ms to cap, so a submit up to a
--     cron-cycle (~60s) after the deadline still scored base_points. Now a
--     submission arriving after cap+3s is forced to a 0-point skip.
--  M1 (MED) current_streak / best_streak were server-owned but NOT frozen by
--     the profiles self-update RLS — client-forgeable. Added to the freeze.
--  M2 (MED) participants could call the spectator RPCs on their OWN match to
--     read options in canonical (unshuffled) order, restoring a positional
--     answer-sharing channel. Participants are now excluded from both.
--  M3 (MED) never-started 'abandoned' matches (null winner) rendered as 'loss'
--     for both in get_profile_matches and 'draw' in get_recent_matches — same
--     match, two verdicts. They're now excluded from history entirely.
--  M4/L9 (MED/LOW) end_current_season snapshot/history/update read profiles in
--     three unlocked passes; a match finalizing mid-reset produced inconsistent
--     season_results / rating_history and could deadlock. Now all profiles are
--     locked in id order first (same order apply_rated_result uses → no deadlock,
--     consistent snapshot).
--  M5 (MED) all-skip 0-0 (and all-wrong) rated matches carry no skill signal and
--     let a smurf farm ~+20 via a guaranteed draw. finalize_match now completes
--     such matches WITHOUT applying any rating.
--  L2 (LOW) advance_timed_out's advance UPDATE had no status/index guard — a
--     concurrent player-advance or forfeit between the loop snapshot and the
--     UPDATE could reset the timer or mutate an abandoned row. Guarded.
-- =========================================================

-- ── C1: forfeit_match — require server-verifiable opponent absence ───────────
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  cap             integer;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  quitter := case when present_player = m.player_a then m.player_b else m.player_a end;

  -- The opponent must have had the current question's FULL deadline (plus a
  -- small network slack) elapse without submitting anything. A live client
  -- auto-submits a null skip at the deadline, so a missing row here means the
  -- opponent is not running the client — i.e. genuinely gone.
  select coalesce(q.duration_ms, sc.cap_ms) into cap
  from questions q
  join section_config sc on sc.section = q.section
  where q.id = m.question_ids[m.current_index + 1];

  if m.question_started_at is null
     or now() < m.question_started_at + ((cap + 5000)::text || ' milliseconds')::interval then
    raise exception 'too early to forfeit — opponent still within the question deadline';
  end if;

  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = m.current_index
  ) then
    raise exception 'opponent answered — not absent';
  end if;

  if not m.is_rated then
    update matches set status='abandoned', ended_at=now(), winner_id=present_player
    where id = p_match_id;
    return;
  end if;

  perform apply_rated_result(p_match_id, present_player, quitter, 1.0);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- ── H1 + shuffle/scoring (restated from 20260713060000, only the late-submit
--    override added) ─────────────────────────────────────────────────────────
create or replace function submit_answer(
  p_match_id uuid, p_question_index smallint, p_selected_index smallint
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m          matches%rowtype;
  q          questions%rowtype;
  cfg        section_config%rowtype;
  uid        uuid := auth.uid();
  is_a       boolean;
  cap        integer;
  taken_ms   integer;
  correct    boolean;
  grace      integer;
  pts        integer;
  n_opts     integer;
  perm       integer[];
  canonical  smallint;
  player_elo integer;
  res_q      numeric;
  suspect    boolean;
  late       boolean;
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
  cap    := coalesce(q.duration_ms, cfg.cap_ms);
  n_opts := jsonb_array_length(q.options);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  -- A submission arriving after the deadline (+3s network slack) scores nothing,
  -- regardless of correctness — taken_ms alone is clamped to cap and would
  -- otherwise still award base_points to a submit up to a cron-cycle late.
  late := (extract(epoch from (now() - m.question_started_at)) * 1000) > cap + 3000;

  -- Map the client's displayed option index back to the canonical index.
  if p_selected_index is null or late then
    canonical := null;
  elsif p_selected_index < 0 or p_selected_index >= n_opts then
    raise exception 'invalid option';
  else
    perm      := option_perm(p_match_id, uid, p_question_index, n_opts);
    canonical := perm[p_selected_index + 1];
  end if;

  correct := (canonical is not null and canonical = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when late               then 0
    when correct            then cfg.base_points + grace
    when canonical is null  then 0
    else                         -cfg.wrong_penalty
  end;

  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    canonical, correct, pts, taken_ms
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

  -- Implausibly-fast correct answer (< 2s): telemetry, excluded from ELO nudge.
  suspect := (correct and taken_ms < 2000);
  if suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Per-question ELO nudge, ATOMIC. A late/skip answer (canonical null) never
  -- nudges — only bumps times_seen.
  if canonical is not null and not suspect then
    select elo into player_elo from profiles where id = uid;
    res_q := case when correct
                  then 0.35 * (taken_ms::numeric / greatest(cap, 1))
                  else 1.0 end;
    update questions
      set elo = greatest(400, least(2800, round(elo
                  + (case when times_seen < 20 then 32 else 16 end)
                  * (res_q - 1.0 / (1.0 + power(10.0, (player_elo - elo) / 400.0))))::int)),
          times_seen = times_seen + 1
      where id = q.id;
  else
    update questions set times_seen = times_seen + 1 where id = q.id;
  end if;

  perform maybe_advance(p_match_id, p_question_index);
  perform broadcast_spectator_update(p_match_id);
end; $$;

-- ── M5: finalize_match — skip rating for no-skill (all-skip / all-wrong) matches
create or replace function finalize_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m           matches%rowtype;
  winner      uuid;
  loser       uuid;
  factor      numeric;
  margin      int;
  F_MIN       constant numeric := 0.3;
  FULL_MARGIN constant numeric := 300;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status = 'completed' or m.status = 'abandoned' then return; end if;

  margin := abs(m.score_a - m.score_b);

  if not m.is_rated then
    update matches set status='completed', ended_at=now(),
      winner_id = case
        when m.score_a > m.score_b then m.player_a
        when m.score_b > m.score_a then m.player_b
        else null end
    where id = p_match_id;
    return;
  end if;

  -- No-skill guard: neither player answered a single question correctly (all
  -- skips, or all wrong). Complete without touching ratings so a colluding pair
  -- can't farm ELO via guaranteed 0-0 draws.
  if m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0 then
    update matches set status='completed', ended_at=now(),
      winner_id = case
        when m.score_a > m.score_b then m.player_a
        when m.score_b > m.score_a then m.player_b
        else null end
    where id = p_match_id;
    return;
  end if;

  if m.score_a = m.score_b then
    perform apply_draw(p_match_id);
    return;
  end if;

  if m.score_a > m.score_b then
    winner := m.player_a; loser := m.player_b;
  else
    winner := m.player_b; loser := m.player_a;
  end if;

  factor := F_MIN + (1.0 - F_MIN) * least(margin::numeric / FULL_MARGIN, 1.0);
  perform apply_rated_result(p_match_id, winner, loser, factor);
end;
$$;

-- ── L2: advance_timed_out — guard the advance UPDATE (restated from 000700) ──
create or replace function advance_timed_out()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r   record;
  cap integer;
  pid uuid;
begin
  update matches
  set status = 'abandoned', ended_at = now()
  where status = 'pending'
    and created_at < now() - interval '5 minutes';

  for r in
    select m.*, q.section, q.id as q_id, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      foreach pid in array array[r.player_a, r.player_b] loop
        insert into match_answers (
          match_id, user_id, question_id, question_index,
          selected_index, is_correct, points_awarded, time_taken_ms
        )
        values (r.id, pid, r.q_id, r.current_index, null, false, 0, cap)
        on conflict (match_id, user_id, question_index) do nothing;
      end loop;

      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id
          and status = 'active'
          and current_index = r.current_index;
      end if;

      perform broadcast_spectator_update(r.id);
    end if;
  end loop;
end;
$$;

revoke execute on function advance_timed_out() from public, anon, authenticated;

-- ── M2: exclude participants from the spectator RPCs (they'd de-shuffle their
--    own match's canonical option order) ────────────────────────────────────
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
    and m.status in ('active', 'completed')
    and (select auth.uid()) not in (m.player_a, m.player_b);
$$;

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
  if auth.uid() in (m.player_a, m.player_b) then
    raise exception 'participants must use get_match_question';
  end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  return query select
    q.id, q.section, q.body, q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at;
end;
$$;

-- ── M3: drop never-started (null-winner) abandons from history ───────────────
create or replace function get_profile_matches(p_username text, p_limit int default 10)
returns table (
  match_id        uuid,
  opponent        text,
  opponent_avatar text,
  my_score        int,
  opp_score       int,
  result          text,
  elo_delta       int,
  played_at       timestamptz
)
language sql stable security definer as $$
  select
    m.id                                                                  as match_id,
    coalesce(pb.display_name, pb.username)                               as opponent,
    pb.avatar_url                                                         as opponent_avatar,
    case when m.player_a = p.id then m.score_a else m.score_b end        as my_score,
    case when m.player_a = p.id then m.score_b else m.score_a end        as opp_score,
    case
      when m.winner_id = p.id                              then 'win'
      when m.winner_id is null and m.status = 'completed' then 'draw'
      else 'loss'
    end                                                                   as result,
    case
      when m.player_a = p.id
        then coalesce(m.elo_a_after, m.elo_a_before) - m.elo_a_before
      else
        coalesce(m.elo_b_after, m.elo_b_before) - m.elo_b_before
    end                                                                   as elo_delta,
    m.ended_at                                                            as played_at
  from profiles p
  join matches m  on m.player_a = p.id or m.player_b = p.id
  join profiles pb on pb.id = case when m.player_a = p.id then m.player_b else m.player_a end
  where p.username = p_username
    and m.status in ('completed', 'abandoned')
    and m.ended_at is not null
    and not (m.status = 'abandoned' and m.winner_id is null)
  order by m.ended_at desc
  limit p_limit
$$;

create or replace function get_recent_matches(p_limit int default 5)
returns table (
  match_id        uuid,
  opponent        text,
  opponent_avatar text,
  my_score        int,
  opp_score       int,
  result          text,
  elo_delta       int,
  played_at       timestamptz
)
language plpgsql stable security definer as $$
declare uid uuid := auth.uid();
begin
  return query
  select
    m.id,
    case
      when m.player_a = uid then coalesce(pb.display_name, pb.username)
      else coalesce(pa.display_name, pa.username)
    end,
    case when m.player_a = uid then pb.avatar_url else pa.avatar_url end,
    case when m.player_a = uid then m.score_a else m.score_b end,
    case when m.player_a = uid then m.score_b else m.score_a end,
    case
      when m.winner_id = uid then 'win'
      when m.winner_id is null then 'draw'
      else 'loss'
    end,
    case
      when m.player_a = uid then coalesce(m.elo_a_after - m.elo_a_before, 0)
      else coalesce(m.elo_b_after - m.elo_b_before, 0)
    end,
    m.ended_at
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where uid in (m.player_a, m.player_b)
    and m.status in ('completed', 'abandoned')
    and not (m.status = 'abandoned' and m.winner_id is null)
  order by m.ended_at desc
  limit p_limit;
end;
$$;

-- ── M4/L9: end_current_season — lock all profiles in id order before the
--    snapshot so a concurrent finalization can't split the reset (restated
--    from 20260702000800, only the lock line added) ──────────────────────────
create or replace function end_current_season()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s seasons%rowtype;
  next_starts timestamptz;
begin
  select * into s from seasons
  where ends_at <= now() and id not in (select season_id from season_results)
  order by ends_at limit 1;

  if not found then return; end if;

  -- Lock every profile in id order (the same order apply_rated_result/apply_draw
  -- lock their pair) so an in-flight rated finalization either fully precedes or
  -- fully follows the reset — no split snapshot, no deadlock.
  perform 1 from profiles order by id for update;

  insert into season_results(season_id, user_id, final_elo, final_rank)
  select s.id, id, elo, rank() over (order by elo desc) from profiles;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta)
  select id, null, elo, 1000 + ((elo - 1000) / 2), (1000 + ((elo - 1000) / 2)) - elo
  from profiles
  where elo <> 1000;

  update profiles set elo = 1000 + ((elo - 1000) / 2);

  next_starts := s.ends_at;
  insert into seasons(name, starts_at, ends_at)
  values (
    'Season ' || (s.id + 1),
    next_starts,
    next_starts + interval '1 month'
  );
end;
$$;

revoke execute on function end_current_season() from public, anon, authenticated;

-- ── M1: freeze current_streak / best_streak in the profiles self-update RLS ──
alter policy profiles_update on profiles with check (
      (id = (select auth.uid()))
  and (elo            = (select p.elo            from profiles p where p.id = (select auth.uid())))
  and (peak_elo       = (select p.peak_elo       from profiles p where p.id = (select auth.uid())))
  and (wins           = (select p.wins           from profiles p where p.id = (select auth.uid())))
  and (losses         = (select p.losses         from profiles p where p.id = (select auth.uid())))
  and (draws          = (select p.draws          from profiles p where p.id = (select auth.uid())))
  and (matches_played = (select p.matches_played from profiles p where p.id = (select auth.uid())))
  and (is_admin       = (select p.is_admin       from profiles p where p.id = (select auth.uid())))
  and (current_streak = (select p.current_streak from profiles p where p.id = (select auth.uid())))
  and (best_streak    = (select p.best_streak    from profiles p where p.id = (select auth.uid())))
);
