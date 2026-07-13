-- =========================================================
-- Audit round 4 — matchmaking handoff + stats/history integrity.
-- Findings from the 1v1 battle-loop audit:
--   1. matchmaking_queue / matches were never explicitly added to the
--      supabase_realtime publication — if the project publishes an explicit
--      table list (as friends_messaging's guarded add implies is possible),
--      the "matched" event never reaches the waiting player and match-question
--      advancement silently breaks. Add both, guarded (no-op under FOR ALL TABLES).
--   2. join_queue's "already in a live match" guard only blocked pending matches
--      younger than 2min — exactly the advance_timed_out abandon threshold. In
--      the ~1min cron-lag window a player could requeue and end up double-booked.
--      Block on ANY pending; the abandon sweep flips stale ones to 'abandoned'.
--   3. try_match_internal could pair a lone waiter with a ghost row in the up-to
--      -90s window before rematch_waiting sweeps it. Add a heartbeat-freshness
--      predicate so pairing ignores stale rows between sweeps.
--   4. finalize_match's no-skill branch left status='completed', winner_id=null,
--      which get_profile_matches/get_recent_matches render as a phantom 'draw'
--      that profiles.draws never counted → history/stats drift. Flip to
--      'abandoned' so the existing null-winner filter hides it (parity with the
--      no-skill forfeit_match branch).
-- CREATE OR REPLACE preserves existing grants; no re-grant needed.
-- =========================================================

-- ── 1. realtime publication ─────────────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table matchmaking_queue;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table matches;
exception when others then null; end $$;

-- ── 2. join_queue: block on any pending match, not just <2min ────────────────
create or replace function join_queue()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare my_elo int;
begin
  perform check_rate_limit('join_queue', 10, 10);

  -- Any live OR pending match blocks requeue. The old "pending younger than
  -- 2min" clause left a cron-lag hole where a stuck-pending player could
  -- double-book; advance_timed_out abandons pending >2min, clearing this guard.
  if exists (
    select 1 from matches
    where (player_a = auth.uid() or player_b = auth.uid())
      and status in ('active', 'pending')
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

-- ── 3. try_match_internal: ignore ghost rows between heartbeat sweeps ────────
create or replace function try_match_internal(p_user_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
  target       integer;
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
    -- Freshness: skip rows whose heartbeat is >90s stale (abandoned tab not yet
    -- swept by rematch_waiting) so a lone waiter is never paired with a ghost.
    and heartbeat_at > now() - interval '90 seconds'
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  target := ((me.elo + opp.elo) / 2)::int;
  q_ids := coalesce(pick_section_question_ids('VARC',  target), '{}')
        || coalesce(pick_section_question_ids('DILR',  target), '{}')
        || coalesce(pick_section_question_ids('QUANT', target), '{}');

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

-- ── 4. finalize_match: no-skill matches abandon (don't render as draws) ──────
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
  -- question: base + max speed bonus + opponent's wrong-penalty).
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

-- ── 5. start_match: 3s synced lead-in before Q1 ─────────────────────────────
-- question_started_at is set 3s in the future so both clients render a shared
-- "match starting" countdown against the same server deadline (clock-offset
-- corrected) before Q1's timer begins — nobody loses part of Q1 to load/latency.
-- Only Q1 gets a lead-in; maybe_advance/finalize set later questions to now().
-- Reconnects mid-question see started_at in the past → no countdown, straight in.
-- search_path pinned inline (the original 002 def relied on the blanket pin that
-- CREATE OR REPLACE drops).
create or replace function start_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or m.status <> 'pending' then return; end if;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  update matches
  set status = 'active', started_at = now(), question_started_at = now() + interval '3 seconds'
  where id = p_match_id;
end;
$$;
