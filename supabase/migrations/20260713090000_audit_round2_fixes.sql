-- =========================================================
-- Audit round 2 (2026-07-13). Fixes the open findings from the full
-- pipeline audit. Every function is recreated from its LATEST prior
-- definition:
--   forfeit_match / submit_answer / finalize_match / advance_timed_out /
--   end_current_season                      ← 20260713080000_audit_fixes
--   apply_draw                              ← 20260713060000_rating_current_elo_zero_sum
--   join_queue                              ← 20260702000000_rpc_rate_limit
--   leave_queue                             ← 002_rpc_functions
--   rematch_waiting                         ← 20260623065814
--   rated_pair_count_today                  ← 20260624092649_fix_logic_and_bugs
--   get_answer_reveal                       ← 20260713040000_fix_option_shuffle_desync
--   profiles_insert policy                  ← 20260627000300
--
-- Fixes:
--  H1 forfeit was a near-dead path: the cron's null skip rows counted as the
--     opponent "answering", so the acceptance window per question was only
--     [deadline+5s, next cron tick]. Cron skip rows now carry
--     time_taken_ms = NULL (a client submission always records a time), and
--     forfeit treats them as ABSENCE evidence: a cron-null row on the previous
--     question lets the present player forfeit immediately. Rated forfeits of
--     no-skill (zero-correct) matches no longer transfer ELO (parity with
--     finalize_match's M5 guard).
--  H2 client clocks were never actually synced — get_server_time() gives the
--     client a real server timestamp for offset computation.
--  H3 ghost queue rows: waiting rows had no liveness signal. Added
--     heartbeat_at + queue_heartbeat(); rematch_waiting cancels waiting rows
--     with a stale heartbeat (>90s) and prunes finished rows (>1 day).
--  H4 join_queue now rejects callers who are already in a live match
--     (active, or pending created <2 min ago) and clears their old
--     non-waiting queue rows (fixes the stale-'matched'-row hijack at the
--     source). advance_timed_out abandons no-show pending matches after
--     2 min (was 5) to match.
--  M1 margin factor was blind to section speed multipliers: FULL_MARGIN is
--     now 20% of the match's own maximum achievable margin (sum over its 9
--     questions of base + penalty + max speed bonus) — ≈300 for a mixed
--     match, so mixed-mode behavior is unchanged, while section-mode matches
--     are judged on their own scale.
--  M2 leave_queue returns whether a row was actually cancelled, so a client
--     that lost the leave-vs-match race can route into the match instead of
--     stranding the opponent.
--  M3 question-ELO nudge hardening: implausibly-fast (<2s) WRONG answers are
--     now excluded too (not just fast correct), and unrated matches never
--     nudge — colluders could loop unrated challenges to distort the bank.
--  M4 draws are now zero-sum: one shared delta at K = least(K_a, K_b),
--     clamped to the 100 floor. The old per-player-K version minted ~+11 net
--     rating per newbie-vs-veteran draw.
--  L1 get_answer_reveal no longer reveals unreached questions on
--     abandoned/pending matches.
--  L2 rated_pair_count_today no longer counts never-rated abandons (ghost
--     matches burned the 3/day budget).
--  L3 no-skill rated matches record winner_id = NULL (they showed no skill
--     signal; history rendered a stat-less "win" before).
--  L4 end_current_season no longer re-ends the same season hourly when
--     profiles is empty; forfeit's deadline guard fails closed on a NULL cap.
--  L5 profiles_insert now pins server-owned columns to their defaults.
-- =========================================================

-- ── H3: queue liveness ────────────────────────────────────────────────────────
alter table matchmaking_queue
  add column if not exists heartbeat_at timestamptz not null default now();

create or replace function queue_heartbeat()
returns boolean language plpgsql security definer
set search_path = pg_catalog, public as $$
declare n int;
begin
  perform check_rate_limit('queue_heartbeat', 10, 10);
  update matchmaking_queue set heartbeat_at = now()
  where user_id = auth.uid() and status = 'waiting';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke execute on function queue_heartbeat() from public, anon;
grant execute on function queue_heartbeat() to authenticated;

-- ── H2: real clock sync ──────────────────────────────────────────────────────
create or replace function get_server_time()
returns timestamptz language sql stable
set search_path = pg_catalog, public as $$
  select now();
$$;
revoke execute on function get_server_time() from public, anon;
grant execute on function get_server_time() to authenticated;

-- ── H4 + housekeeping: join_queue ────────────────────────────────────────────
create or replace function join_queue()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare my_elo int;
begin
  perform check_rate_limit('join_queue', 10, 10);

  if exists (
    select 1 from matches
    where (player_a = auth.uid() or player_b = auth.uid())
      and (status = 'active'
           or (status = 'pending' and created_at > now() - interval '2 minutes'))
  ) then
    raise exception 'already in a live match';
  end if;

  -- prune this user's finished rows (matched/cancelled) so a stale 'matched'
  -- row can never be mistaken for a live one, and the table doesn't grow
  delete from matchmaking_queue where user_id = auth.uid() and status <> 'waiting';

  select elo into my_elo from profiles where id = auth.uid();
  insert into matchmaking_queue(user_id, elo)
  values (auth.uid(), my_elo)
  on conflict (user_id) where status='waiting'
  do update set heartbeat_at = now(), elo = excluded.elo;
  perform try_match();
end;
$$;

-- ── M2: leave_queue reports whether it actually cancelled a row ──────────────
drop function if exists leave_queue();
create function leave_queue()
returns boolean language plpgsql security definer
set search_path = pg_catalog, public as $$
declare n int;
begin
  update matchmaking_queue set status='cancelled'
  where user_id = auth.uid() and status='waiting';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke execute on function leave_queue() from public, anon;
grant execute on function leave_queue() to authenticated;

-- ── H3: rematch_waiting sweeps ghosts before pairing ─────────────────────────
create or replace function rematch_waiting()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  rec record;
begin
  -- ghost sweep: a live queue client heartbeats every ~20s
  update matchmaking_queue set status = 'cancelled'
  where status = 'waiting' and heartbeat_at < now() - interval '90 seconds';

  -- prune finished rows so the table stays bounded
  delete from matchmaking_queue
  where status <> 'waiting' and enqueued_at < now() - interval '1 day';

  for rec in
    select user_id
    from matchmaking_queue
    where status = 'waiting'
    order by enqueued_at
  loop
    perform try_match_internal(rec.user_id);
  end loop;
end;
$$;
revoke execute on function rematch_waiting() from public, anon, authenticated;

-- ── L2: rated_pair_count_today ignores never-rated abandons ──────────────────
create or replace function rated_pair_count_today(a uuid, b uuid)
returns int language sql stable security definer
set search_path = pg_catalog, public as $$
  select count(*)::int
  from matches
  where ((player_a = a and player_b = b) or (player_b = a and player_a = b))
    and is_rated = true
    and not (status = 'abandoned' and elo_a_after is null)
    and created_at > now() - interval '24 hours';
$$;
revoke execute on function rated_pair_count_today(uuid, uuid) from public, anon, authenticated;

-- ── H1: advance_timed_out — cron skip rows are marked by a NULL time
--    (a client submission always records time_taken_ms via submit_answer),
--    and no-show pending matches abandon after 2 min ───────────────────────────
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
    and created_at < now() - interval '2 minutes';

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
        values (r.id, pid, r.q_id, r.current_index, null, false, 0, null)
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

-- ── C1-redux: drop the pre-C1 two-arg forfeit_match. It survived every audit
--    because later migrations recreated forfeit_match(uuid) — a DIFFERENT
--    signature — leaving this overload live and client-executable. It has no
--    caller-identity check (any authed user could forfeit any active match,
--    naming either side winner), and since apply_rated_result's int-delta
--    overload was dropped in 20260713060000, its integer d_win now coerces
--    into the numeric FACTOR parameter — a transfer of the loser's whole
--    headroom. ──────────────────────────────────────────────────────────────
drop function if exists forfeit_match(uuid, uuid);

-- ── H1: forfeit_match — cron-null rows are ABSENCE evidence, not answers ─────
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
  -- got anything right carries no signal — end it without transferring ELO.
  if not m.is_rated
     or (m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0) then
    update matches set status='abandoned', ended_at=now(), winner_id=present_player
    where id = p_match_id;
    return;
  end if;

  perform apply_rated_result(p_match_id, present_player, quitter, 1.0);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- ── M3: submit_answer — fast-wrong excluded from the nudge, unrated matches
--    never nudge, and the cron-race insert conflict resolves silently ─────────
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
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when late               then 0
    when correct            then cfg.base_points + grace
    when canonical is null  then 0
    else                         -cfg.wrong_penalty
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

-- ── M4: apply_draw — zero-sum at K = least(K_a, K_b) ─────────────────────────
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
  d        int;
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

  -- One shared delta (A's perspective) at the more conservative K keeps draws
  -- strictly zero-sum — per-player Ks minted rating on every mismatched draw.
  d := round(least(k_a, k_b) * (0.5 - e_a))::int;
  if d >= 0 then
    d := least(d, greatest(b_elo - 100, 0));
  else
    d := -least(-d, greatest(a_elo - 100, 0));
  end if;

  a_after := a_elo + d;
  b_after := b_elo - d;

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

-- ── M1 + L3: finalize_match — margin normalized to the match's own maximum;
--    no-skill matches record no winner ────────────────────────────────────────
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
  -- skips, or all wrong). Complete without touching ratings so a colluding pair
  -- can't farm ELO via guaranteed 0-0 draws. No winner either — a match with
  -- zero skill signal shouldn't render as a win in history.
  if m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0 then
    update matches set status='completed', ended_at=now(), winner_id=null
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
  -- question: base + max speed bonus + opponent's wrong-penalty). A fixed
  -- 300 overweighted ×2-speed_mult sections by ~26%. 20% of max ≈ 300 for a
  -- mixed 3-3-3 match, so mixed-mode behavior is unchanged.
  select 0.2 * sum(cfg.base_points + cfg.wrong_penalty
           + cfg.speed_mult * floor(coalesce(q.duration_ms, cfg.cap_ms)::numeric / cfg.grace_block_ms))
    into full_margin
  from unnest(m.question_ids) as qid
  join questions q on q.id = qid
  join section_config cfg on cfg.section = q.section;
  full_margin := coalesce(nullif(full_margin, 0), 300);

  factor := F_MIN + (1.0 - F_MIN) * least(margin::numeric / full_margin, 1.0);
  perform apply_rated_result(p_match_id, winner, loser, factor);
end;
$$;

-- ── L1: get_answer_reveal — never reveal unreached questions ─────────────────
create or replace function get_answer_reveal(p_match_id uuid, p_index smallint)
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
  m            matches%rowtype;
  q            questions%rowtype;
  perm         integer[];
  disp_correct smallint;
  v_passage    text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  -- Only reveal once the question has closed
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  -- On abandoned/pending matches only questions that were actually served may
  -- be revealed — the old gate leaked the whole bank tail after a forfeit.
  if m.status <> 'completed'
     and (p_index > m.current_index
          or (p_index = m.current_index and m.question_started_at is null)) then
    raise exception 'question not reached';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select (ord - 1)::smallint into disp_correct
  from unnest(perm) with ordinality as u(p, ord)
  where p = q.correct_index;

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query
    select
      disp_correct,
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

-- ── L4: end_current_season — don't loop on an empty ladder ───────────────────
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

  -- With zero profiles the season_results insert is empty, so the same season
  -- would be re-selected (and 'Season N+1' re-inserted) every hourly tick.
  if not exists (select 1 from profiles) then return; end if;

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

-- ── L5: profiles_insert pins server-owned columns to their defaults ──────────
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to public
  with check (
        id = (select auth.uid())
    and elo = 1000 and peak_elo = 1000
    and wins = 0 and losses = 0 and draws = 0 and matches_played = 0
    and current_streak = 0 and best_streak = 0
    and is_admin = false
  );
