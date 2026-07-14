-- =========================================================
-- Scoring EV + section parity + ELO margin fixes
--
-- 1. TIME-SCALED WRONG PENALTY (submit_answer). The flat -30 penalty made a
--    blind instant guess EV-positive on every section (4 options: EV of an
--    instant DILR guess was 0.25*148 - 0.75*30 = +14.5 vs 0 for a skip), and
--    the decaying speed bonus meant the OPTIMAL guess was the instant one.
--    New penalty rides the same speed curve as the reward:
--        penalty(t) = (base_points + bonus(t)) / (n_options - 1)
--    which makes a random guess exactly EV-neutral at every t, for any
--    option count and any speed_mult (the multiplier cancels), and converges
--    to CAT's canonical 1:3 penalty ratio at the cap. section_config.wrong_penalty
--    is superseded by this derivation (column kept; no longer read here).
--
-- 2. SECTION PARITY (section_config). cap x speed_mult made max/question
--    118 VARC / 142 QUANT / 148 DILR — Quant/DILR were silently worth ~25%
--    more in mixed matches. Real CAT weights sections equally. speed_mult
--    becomes numeric and is retuned so every section's max speed bonus = 40
--    (max/question = 140 flat):
--        VARC  90s/5s = 18 blocks x 2.22 -> 40
--        QUANT 105s/5s = 21 blocks x 1.90 -> 40
--        DILR  120s/5s = 24 blocks x 1.67 -> 40
--
-- 3. FAVORITE-SHRINK on the margin factor (apply_rated_result). Known
--    margin-of-victory Elo bug (documented by FiveThirtyEight's NFL Elo):
--    favorites win big precisely when expected to win at all, so
--    margin x (1 - E) systematically overrates them (autocorrelation).
--    Multiplicative correction when the winner was the rating favorite:
--        factor *= 2.2 / (0.001 * (R_w - R_l) + 2.2)
--
-- 4. greatest(1, ...) -> greatest(0, ...) on the raw delta. The forced
--    minimum +1 let a top player farm +1 off each of many far-weaker
--    opponents indefinitely (the per-pair guard only limits ONE victim).
--    Fully-expected narrow wins may now move 0 — matching chess rounding.
--
-- INVARIANT PARTNERS updated together: submit_answer (penalty) and
-- finalize_match (FULL margin normalizer must mirror the per-question max
-- swing, now (base + max_bonus) * (1 + 1/(n-1)) instead of
-- base + max_bonus + wrong_penalty). Guarded by scripts/elo-stress-test.sql.
-- =========================================================

-- ── 2. section parity: speed_mult numeric, equal max bonus (40) per section ──
alter table section_config alter column speed_mult type numeric(4,2);

update section_config set speed_mult = 2.22 where section = 'VARC';
update section_config set speed_mult = 1.90 where section = 'QUANT';
update section_config set speed_mult = 1.67 where section = 'DILR';

-- ── 1. submit_answer: time-scaled EV-neutral wrong penalty ───────────────────
-- Base copied from 20260713090000_audit_round2_fixes.sql (latest def).
-- Changes: grace rounds a numeric speed_mult; wrong branch derives the
-- penalty from (base + grace) / (n_opts - 1) instead of cfg.wrong_penalty.
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
  inserted   int;
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
  grace   := round(cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms))::int;
  -- Wrong penalty rides the same speed curve as the reward, divided by the
  -- number of wrong options: a random guess is exactly EV-neutral at every t
  -- (fast wrong answers cost more, matching their larger potential reward).
  pts     := case
    when late               then 0
    when correct            then cfg.base_points + grace
    when canonical is null  then 0
    else                         -round((cfg.base_points + grace)::numeric
                                        / greatest(n_opts - 1, 1))::int
  end;

  -- The cron's skip-row insert doesn't hold this match's row lock, so an
  -- in-slack submit can lose the unique-key race; resolve it as the skip the
  -- cron already recorded instead of aborting the whole call.
  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    canonical, correct, pts, taken_ms
  )
  on conflict (match_id, user_id, question_index) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return; end if;

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  -- Any implausibly-fast (<2s) real answer is excluded from the question-ELO
  -- nudge — fast-wrong deflation is as manipulable as fast-correct inflation.
  -- Telemetry keeps its original meaning: fast CORRECT answers only.
  suspect := (canonical is not null and taken_ms < 2000);
  if correct and suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Per-question ELO nudge, ATOMIC. Only rated matches nudge (unrated
  -- challenges are uncapped per pair — a collusion channel otherwise); a
  -- late/skip answer (canonical null) never nudges — only bumps times_seen.
  if canonical is not null and not suspect and m.is_rated then
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

-- ── invariant partner: finalize_match's FULL mirrors the new max swing ───────
-- Base copied from 20260714140000_matchmaking_stats_fixes.sql (latest def).
-- Change: per-question max margin is (base + max_bonus) * (1 + 1/(n-1))
-- — winner's instant-correct plus loser's instant-wrong derived penalty —
-- replacing the retired flat cfg.wrong_penalty term.
create or replace function finalize_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m           matches%rowtype;
  winner      uuid;
  loser       uuid;
  factor      numeric;
  margin      int;
  full_margin numeric;
  F_MIN       constant numeric := 0.3;
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
  -- skips, or all wrong). Abandon without touching ratings so a colluding pair
  -- can't farm ELO via guaranteed 0-0 draws, AND so the null-winner history
  -- filter hides it — a match with zero skill signal shouldn't render at all
  -- (a 'completed' null-winner row used to show as a phantom draw the profile
  -- draw counter never recorded). Parity with the no-skill forfeit_match branch.
  if m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0 then
    update matches set status='abandoned', ended_at=now(), winner_id=null
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

  -- Normalize the margin to THIS match's maximum achievable margin (per
  -- question: winner's base + max speed bonus, plus the loser's max derived
  -- wrong-penalty (base + max bonus)/(n-1) — mirrors submit_answer's formula).
  select 0.2 * sum(
           (cfg.base_points
            + round(cfg.speed_mult * floor(coalesce(q.duration_ms, cfg.cap_ms)::numeric / cfg.grace_block_ms)))
           * (1 + 1.0 / greatest(jsonb_array_length(q.options) - 1, 1)))
    into full_margin
  from unnest(m.question_ids) as qid
  join questions q on q.id = qid
  join section_config cfg on cfg.section = q.section;
  full_margin := coalesce(nullif(full_margin, 0), 300);

  factor := F_MIN + (1.0 - F_MIN) * least(margin::numeric / full_margin, 1.0);
  perform apply_rated_result(p_match_id, winner, loser, factor);
end;
$$;

-- ── 3 + 4. apply_rated_result: favorite-shrink, no forced +1 minimum ─────────
-- Base copied from 20260713060000_rating_current_elo_zero_sum.sql (latest def).
create or replace function apply_rated_result(
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

  -- Favorite-shrink (FiveThirtyEight-style): margin-of-victory Elo overrates
  -- favorites — they win big precisely when expected to win at all, so
  -- factor x (1 - E) double-counts (autocorrelation). Shrink the margin
  -- factor as the winner's rating edge grows; underdog wins are untouched.
  if w_elo > l_elo then
    p_factor := p_factor * 2.2 / (0.001 * (w_elo - l_elo)::numeric + 2.2);
  end if;

  -- No forced +1 minimum (was greatest(1, ...)): a fully-expected narrow win
  -- may move 0 — the old floor let top players farm +1 off each of many
  -- far-weaker opponents indefinitely.
  eff   := greatest(0, round(k * (1.0 - e_win) * p_factor))::int;
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
