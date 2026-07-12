-- =========================================================
-- Rating-finalization correctness, three fixes:
--
-- 1. STALE-BASE LOST UPDATE. apply_rated_result/apply_draw applied deltas to
--    elo_*_before snapshotted at match CREATION. A player finishing two
--    overlapping rated matches had the second result overwrite the first
--    (elo = stale_base + delta). Fix: the delta is now computed and applied
--    inside apply_rated_result/apply_draw from the CURRENT profiles.elo,
--    read under row locks. Callers (finalize_match, forfeit_match) pass only
--    the margin factor; K/expected-score math moved into the apply function
--    so it uses the same locked reads. matches.elo_*_before is re-synced to
--    the true base at finalization so result-screen deltas stay consistent
--    with rating_history.
--    Semantics change: ratings are now relative to each player's rating AT
--    FINALIZATION, not at match creation.
--
-- 2. ZERO-SUM FLOOR. The 100-ELO floor used to truncate only the loser's
--    loss while the winner still gained the full delta — net rating
--    inflation. Now the applied delta is capped at what the loser can
--    actually lose: eff = greatest(0, least(delta, loser_elo - 100)).
--    Winner and loser move by exactly eff (a winner beating a floored
--    opponent gains nothing). Draws keep per-player K deltas and are not
--    zero-sum by design (each side's K differs); the floor there is
--    unchanged.
--
-- 3. QUESTION-ELO STALE READ. submit_answer computed the expected score from
--    q.elo read early without a lock; concurrent submits both used the old
--    rating. The nudge is now a single self-contained UPDATE that reads elo,
--    times_seen (provisional K) and applies the clamp atomically under the
--    row lock the UPDATE itself takes.
--
-- Profile rows are always locked in id order (both here and in apply_draw)
-- so two concurrent finalizations touching the same pair can't deadlock.
-- =========================================================

-- ── 1+2. apply_rated_result: signature change (factor in, delta computed
--         inside). Old int-delta version dropped. ────────────────────────────
drop function if exists apply_rated_result(uuid, uuid, uuid, int);

create function apply_rated_result(
  p_match_id uuid,
  p_winner   uuid,
  p_loser    uuid,
  p_factor   numeric
)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m       matches%rowtype;
  w_elo   int;
  w_games int;
  l_elo   int;
  k       int;
  e_win   numeric;
  eff     int;
  w_after int;
  l_after int;
  a_before int;
  b_before int;
  a_after  int;
  b_after  int;
begin
  select * into m from matches where id = p_match_id for update;

  -- Lock both profile rows in id order, then read CURRENT ratings.
  perform 1 from profiles where id in (m.player_a, m.player_b) order by id for update;
  select elo, matches_played into w_elo, w_games from profiles where id = p_winner;
  select elo into l_elo from profiles where id = p_loser;

  k     := case when w_games < 30 then 40 when w_elo < 2000 then 24 else 16 end;
  e_win := 1.0 / (1.0 + power(10, (l_elo - w_elo)::numeric / 400.0));
  eff   := greatest(1, round(k * (1.0 - e_win) * p_factor))::int;
  -- zero-sum floor: never take the loser below 100, never give the winner
  -- more than the loser lost
  eff   := greatest(0, least(eff, l_elo - 100));

  w_after := w_elo + eff;
  l_after := l_elo - eff;

  if p_winner = m.player_a then
    a_before := w_elo;  a_after := w_after;
    b_before := l_elo;  b_after := l_after;
  else
    b_before := w_elo;  b_after := w_after;
    a_before := l_elo;  a_after := l_after;
  end if;

  update matches set status='completed', ended_at=now(), winner_id=p_winner,
    elo_a_before=a_before, elo_b_before=b_before,
    elo_a_after=a_after,   elo_b_after=b_after
  where id = p_match_id;

  update profiles set
    elo=a_after,
    peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end),
    current_streak = case when p_winner = id then current_streak + 1 else 0 end,
    best_streak    = case when p_winner = id then greatest(best_streak, current_streak + 1) else best_streak end
  where id = m.player_a;

  update profiles set
    elo=b_after,
    peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end),
    current_streak = case when p_winner = id then current_streak + 1 else 0 end,
    best_streak    = case when p_winner = id then greatest(best_streak, current_streak + 1) else best_streak end
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, a_before, a_after, a_after - a_before),
    (m.player_b, p_match_id, b_before, b_after, b_after - b_before);
end;
$$;

revoke execute on function apply_rated_result(uuid, uuid, uuid, numeric) from public, anon, authenticated;

-- ── 1. apply_draw: current ratings under ordered locks ───────────────────────
create or replace function apply_draw(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m        matches%rowtype;
  a_elo    int;
  b_elo    int;
  k_a      int;
  k_b      int;
  e_a      numeric;
  e_b      numeric;
  d_a      int;
  d_b      int;
  a_after  int;
  b_after  int;
begin
  select * into m from matches where id = p_match_id for update;

  perform 1 from profiles where id in (m.player_a, m.player_b) order by id for update;
  select elo, case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into a_elo, k_a from profiles where id = m.player_a;
  select elo, case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into b_elo, k_b from profiles where id = m.player_b;

  e_a := 1.0 / (1.0 + power(10, (b_elo - a_elo)::numeric / 400.0));
  e_b := 1.0 - e_a;

  d_a := round(k_a * (0.5 - e_a))::int;
  d_b := round(k_b * (0.5 - e_b))::int;

  a_after := greatest(100, a_elo + d_a);
  b_after := greatest(100, b_elo + d_b);

  update matches set status='completed', ended_at=now(), winner_id=null,
    elo_a_before=a_elo, elo_b_before=b_elo,
    elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set elo=a_after, peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1, draws=draws+1, current_streak=0
  where id = m.player_a;

  update profiles set elo=b_after, peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1, draws=draws+1, current_streak=0
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, a_elo, a_after, a_after - a_elo),
    (m.player_b, p_match_id, b_elo, b_after, b_after - b_elo);
end;
$$;

-- ── finalize_match: margin factor only; rating math lives in apply_rated_result
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

-- ── forfeit_match: factor = 1.0 (full margin), grace guard unchanged ─────────
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  -- Require ≥20s since current question started to prevent
  -- instant-forfeit on brief disconnects.
  if m.question_started_at is not null
     and now() < m.question_started_at + interval '20 seconds' then
    raise exception 'too early to forfeit — grace period not elapsed';
  end if;

  quitter := case when present_player = m.player_a then m.player_b else m.player_a end;

  if not m.is_rated then
    update matches set status='abandoned', ended_at=now(), winner_id=present_player
    where id = p_match_id;
    return;
  end if;

  perform apply_rated_result(p_match_id, present_player, quitter, 1.0);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- ── 3. submit_answer: atomic question-ELO nudge (restated from
--       20260713050000; ONLY the questions UPDATE changes) ────────────────────
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

  -- Map the client's displayed option index back to the canonical index.
  if p_selected_index is null then
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
  -- ponytail: flat 2s threshold; per-section thresholds if false positives matter.
  suspect := (correct and taken_ms < 2000);
  if suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Per-question ELO nudge, ATOMIC: expected score, provisional K, and clamp
  -- all computed from the row's current values inside one UPDATE, so
  -- concurrent submits can't apply a delta derived from a stale rating.
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
