-- Arena: 4–8 player rated matchmaking with a ready-check.
--
-- Separate tables on purpose: the 1v1 engine (matches/match_answers + every
-- lifecycle, spectator and Ninja RPC) is hard-wired to player_a/player_b.
-- Arena reuses the pieces that are seat-count agnostic:
--   · question_cap_ms(question_ids, idx)   — single cap source
--   · option_perm(arena_id, uid, idx, n)   — per-player shuffle, arena id as seed
--   · pick_section_question_ids / pick_quant_question_ids with all seats' ids
--   · submit_answer's scoring block (copied; keep the two in lockstep —
--     scripts/arena-test.sql asserts equal points for equal inputs)
--
-- Flow: arena_join → arena_queue row → try_arena_internal pops the oldest
-- waiter's ELO band when 8 are waiting, or 4+ once the oldest has waited 60s
-- → arena 'forming' with a 15s ready-check → all accept = 'active' (self-paced,
-- own clock per seat) / any decline or timeout = 'cancelled', accepters requeued
-- with their original enqueued_at, the rest get a 2-minute cooldown.
-- Clients poll arena_heartbeat / get_arena_state (no realtime); get_arena_state
-- and the per-minute arena_sweep cron drain expired clocks and finalize.
--
-- Rating: every pair of seats is scored as a 1v1 under apply_rated_result's
-- math (K = least of the pair, margin factor, favorite-shrink): the higher
-- rank wins the pair, a full tie is a draw. Scaled by 2/(N-1) and rounded per pair, so the total is exactly
-- zero-sum. Wins/losses/streaks/matches_played are NOT touched — those are 1v1
-- stats and arena placements would distort win rate.

-- ── tables (RLS on, zero policies: definer-only) ────────────────────────────
create table arenas (
  id              uuid primary key default gen_random_uuid(),
  status          text not null default 'forming'
                  check (status in ('forming', 'active', 'completed', 'cancelled')),
  question_ids    uuid[] not null check (array_length(question_ids, 1) = 9),
  accept_deadline timestamptz not null,
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);
create index arenas_status_idx on arenas (status);

create table arena_players (
  arena_id    uuid not null references arenas(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  seat        smallint not null,
  accepted_at timestamptz,
  declined    boolean not null default false,
  q_started   timestamptz,
  score       integer not null default 0,
  correct     integer not null default 0,
  time_ms     integer not null default 0,
  rank        smallint,
  elo_before  integer,
  elo_after   integer,
  primary key (arena_id, user_id)
);
create index arena_players_user_idx on arena_players (user_id);

create table arena_answers (
  arena_id       uuid not null,
  user_id        uuid not null,
  question_index smallint not null check (question_index between 0 and 8),
  question_id    uuid not null references questions(id),
  selected_index smallint,
  answer_text    text,
  is_correct     boolean not null default false,
  points_awarded integer not null default 0,
  time_taken_ms  integer,            -- NULL = sweep skip-row marker
  created_at     timestamptz not null default now(),
  primary key (arena_id, user_id, question_index),
  foreign key (arena_id, user_id) references arena_players(arena_id, user_id) on delete cascade
);
create index arena_answers_question_idx on arena_answers (question_id);

create table arena_queue (
  user_id      uuid primary key references profiles(id) on delete cascade,
  elo          integer not null,
  status       text not null default 'waiting' check (status in ('waiting', 'forming')),
  arena_id     uuid references arenas(id) on delete set null,
  enqueued_at  timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
create index arena_queue_waiting_idx on arena_queue (status, enqueued_at);

alter table arenas        enable row level security;
alter table arena_players enable row level security;
alter table arena_answers enable row level security;
alter table arena_queue   enable row level security;

-- An arena rating row has match_id NULL, which every "season reset row" filter
-- (match_id is null) would misread. Readers must test BOTH ids.
alter table rating_history add column arena_id uuid references arenas(id) on delete set null;
create index rating_history_arena_idx on rating_history (arena_id) where arena_id is not null;

-- ── in_live_arena: the one definition of "busy in arena" ────────────────────
-- Queued, in a ready-check, or playing. Used by arena_join, join_queue,
-- accept_challenge and (by the same predicate, client-side) inLiveMatch.
create or replace function in_live_arena(p_uid uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists (select 1 from arena_queue q where q.user_id = p_uid)
      or exists (
        select 1 from arena_players ap join arenas a on a.id = ap.arena_id
        where ap.user_id = p_uid and not ap.declined and a.status in ('forming', 'active')
      );
$$;
revoke all on function in_live_arena(uuid) from public, anon, authenticated;

-- ── try_arena_internal: pop a lobby ─────────────────────────────────────────
-- ponytail: one advisory lock serialises every pop (a pop locks up to 8 rows,
-- SKIP LOCKED over a set gains nothing at this scale); per-band locks if
-- arena traffic ever makes this a hotspot.
create or replace function try_arena_internal(p_uid uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  anchor   arena_queue%rowtype;
  anchors  uuid[];
  a_uid    uuid;
  wait_s   int;
  band     int;
  players  uuid[];
  n        int;
  target   int;
  n_varc   int;
  n_dilr   int;
  q_ids    uuid[];
  new_id   uuid;
begin
  perform pg_advisory_xact_lock(hashtext('arena_pop'));

  -- Try the oldest waiter first (widest band), then the caller's own band.
  select array_remove(array[
           (select user_id from arena_queue
             where status = 'waiting' and heartbeat_at > now() - interval '30 seconds'
             order by enqueued_at limit 1),
           p_uid], null)
    into anchors;

  foreach a_uid in array anchors loop
    select * into anchor from arena_queue
    where user_id = a_uid and status = 'waiting' and heartbeat_at > now() - interval '30 seconds';
    continue when not found;

    wait_s := extract(epoch from (now() - anchor.enqueued_at))::int;
    band   := least(1000, 100 + wait_s * 20);   -- same widening as try_match_internal

    select array_agg(user_id order by d, enqueued_at) into players from (
      select user_id, enqueued_at, abs(elo - anchor.elo) as d
      from arena_queue
      where status = 'waiting'
        and heartbeat_at > now() - interval '30 seconds'
        and abs(elo - anchor.elo) <= band
      order by abs(elo - anchor.elo), enqueued_at
      limit 8
    ) t;
    n := coalesce(cardinality(players), 0);

    continue when n < 4 or (n < 8 and wait_s < 60);

    select avg(elo)::int into target from arena_queue where user_id = any(players);

    -- Same adaptive fill + exactly-9 guard as try_match_internal.
    n_varc := case when (select count(*) from questions where section = 'VARC' and is_active) >= 3 then 3 else 0 end;
    n_dilr := case when (select count(*) from questions where section = 'DILR' and is_active) >= 3 then 3 else 0 end;
    q_ids := case when n_varc = 3 then coalesce(pick_section_question_ids('VARC', target, players), '{}') else '{}' end
          || case when n_dilr = 3 then coalesce(pick_section_question_ids('DILR', target, players), '{}') else '{}' end
          || coalesce(pick_quant_question_ids(target, 9 - n_varc - n_dilr, players), '{}');
    if coalesce(array_length(q_ids, 1), 0) <> 9 then
      return null;  -- content gap: everyone stays waiting, non-throwing
    end if;

    insert into arenas (question_ids, accept_deadline)
    values (q_ids, now() + interval '15 seconds')
    returning id into new_id;

    insert into arena_players (arena_id, user_id, seat)
    select new_id, u, (ord - 1)::smallint
    from unnest(players) with ordinality as x(u, ord);

    update arena_queue set status = 'forming', arena_id = new_id
    where user_id = any(players);

    return new_id;
  end loop;

  return null;
end;
$$;
revoke all on function try_arena_internal(uuid) from public, anon, authenticated;

-- ── arena_resolve_ready: close a failed ready-check ─────────────────────────
create or replace function arena_resolve_ready(p_arena uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar arenas%rowtype;
begin
  select * into ar from arenas where id = p_arena for update;
  if not found or ar.status <> 'forming' then return; end if;
  if now() <= ar.accept_deadline
     and not exists (select 1 from arena_players where arena_id = p_arena and declined) then
    return;
  end if;

  update arenas set status = 'cancelled', ended_at = now() where id = p_arena;

  -- Accepters go back to waiting with their ORIGINAL enqueued_at (priority kept).
  update arena_queue q set status = 'waiting', arena_id = null, heartbeat_at = now()
  from arena_players ap
  where ap.arena_id = p_arena and ap.user_id = q.user_id
    and ap.accepted_at is not null and not ap.declined and q.arena_id = p_arena;

  -- Decliners and no-shows leave the queue; the 2-minute cooldown is derived
  -- in arena_join from this cancelled arena, no extra column.
  delete from arena_queue q
  using arena_players ap
  where ap.arena_id = p_arena and ap.user_id = q.user_id and q.arena_id = p_arena
    and (ap.accepted_at is null or ap.declined);
end;
$$;
revoke all on function arena_resolve_ready(uuid) from public, anon, authenticated;

-- ── arena_join ──────────────────────────────────────────────────────────────
create or replace function arena_join()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid    uuid := auth.uid();
  my_elo int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('arena_join', 10, 10);

  -- Already queued/forming/playing in an arena: joining again is a no-op, so a
  -- refresh of /arena just resumes.
  if in_live_arena(uid) then return; end if;

  if exists (
    select 1 from matches
    where (player_a = uid or player_b = uid) and status in ('active', 'pending')
  ) then
    raise exception 'already in a live match';
  end if;
  if exists (select 1 from matchmaking_queue where user_id = uid and status = 'waiting') then
    raise exception 'already in the 1v1 queue';
  end if;
  if exists (
    select 1 from arena_players ap join arenas a on a.id = ap.arena_id
    where ap.user_id = uid and a.status = 'cancelled'
      and (ap.accepted_at is null or ap.declined)
      and a.ended_at > now() - interval '2 minutes'
  ) then
    raise exception 'arena cooldown: you missed a ready-check, try again in a couple of minutes';
  end if;

  select elo into my_elo from profiles where id = uid;
  insert into arena_queue (user_id, elo) values (uid, my_elo)
  on conflict (user_id) do nothing;

  perform try_arena_internal(uid);
end;
$$;
revoke all on function arena_join() from public, anon;
grant execute on function arena_join() to authenticated;

-- ── arena_leave: leave the WAITING queue (false = already in a ready-check) ──
create or replace function arena_leave()
returns boolean language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  delete from arena_queue where user_id = auth.uid() and status = 'waiting';
  return found;
end;
$$;
revoke all on function arena_leave() from public, anon;
grant execute on function arena_leave() to authenticated;

-- ── arena_accept / arena_decline ────────────────────────────────────────────
create or replace function arena_accept(p_arena uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar arenas%rowtype;
begin
  select * into ar from arenas where id = p_arena for update;
  if not found then raise exception 'arena not found'; end if;
  if ar.status <> 'forming' then return; end if;
  if now() > ar.accept_deadline then
    perform arena_resolve_ready(p_arena);
    return;
  end if;

  update arena_players set accepted_at = coalesce(accepted_at, now())
  where arena_id = p_arena and user_id = auth.uid() and not declined;
  if not found then raise exception 'not in this arena'; end if;

  if not exists (select 1 from arena_players where arena_id = p_arena and accepted_at is null) then
    update arenas set status = 'active', started_at = now() where id = p_arena;
    -- 5s lead-in before everyone's first question clock starts.
    update arena_players set q_started = now() + interval '5 seconds' where arena_id = p_arena;
    delete from arena_queue where arena_id = p_arena;
  end if;
end;
$$;
revoke all on function arena_accept(uuid) from public, anon;
grant execute on function arena_accept(uuid) to authenticated;

create or replace function arena_decline(p_arena uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar arenas%rowtype;
begin
  select * into ar from arenas where id = p_arena for update;
  if not found or ar.status <> 'forming' then return; end if;
  update arena_players set declined = true
  where arena_id = p_arena and user_id = auth.uid();
  if not found then raise exception 'not in this arena'; end if;
  -- One decline already sinks the lobby — resolve now rather than make the
  -- other seats sit out the countdown.
  perform arena_resolve_ready(p_arena);
end;
$$;
revoke all on function arena_decline(uuid) from public, anon;
grant execute on function arena_decline(uuid) to authenticated;

-- ── finalize_arena: rank + pairwise zero-sum ELO ────────────────────────────
create or replace function finalize_arena(p_arena uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar          arenas%rowtype;
  full_margin numeric;
  uids        uuid[];
  scores      int[];
  corrects    int[];
  times       int[];
  elos        int[];
  ks          int[];
  deltas      int[];
  n           int;
  i           int;
  j           int;
  k           int;
  e_i         numeric;
  f           numeric;
  d           int;
  w           numeric;
  any_skill   boolean;
  F_MIN       constant numeric := 0.3;
begin
  select * into ar from arenas where id = p_arena for update;
  if not found or ar.status <> 'active' then return; end if;

  -- Rank: score, then correct count, then total correct time (faster first).
  update arena_players ap set rank = r.rn
  from (
    select user_id, row_number() over (order by score desc, correct desc, time_ms asc, seat) as rn
    from arena_players where arena_id = p_arena
  ) r
  where ap.arena_id = p_arena and ap.user_id = r.user_id;

  -- Lock every seat's profile in id order (same discipline as apply_rated_result),
  -- then read CURRENT ratings.
  perform 1 from profiles where id in (select user_id from arena_players where arena_id = p_arena)
  order by id for update;

  select array_agg(ap.user_id order by ap.rank),
         array_agg(ap.score   order by ap.rank),
         array_agg(ap.correct order by ap.rank),
         array_agg(ap.time_ms order by ap.rank),
         array_agg(p.elo      order by ap.rank),
         array_agg(case when p.matches_played < 30 then 40 when p.elo < 2000 then 24 else 16 end order by ap.rank),
         bool_or(ap.correct > 0)
    into uids, scores, corrects, times, elos, ks, any_skill
  from arena_players ap join profiles p on p.id = ap.user_id
  where ap.arena_id = p_arena;

  n := cardinality(uids);
  deltas := array_fill(0, array[n]);

  -- No-skill guard (mirrors finalize_match): nobody got anything right → no
  -- rating moves, so a colluding lobby can't farm via all-skip.
  if any_skill and n >= 2 then
    -- FULL margin: same per-match normalisation as finalize_match.
    select 0.2 * sum(
             (cfg.base_points
              + round(cfg.speed_mult * floor(coalesce(q.duration_ms, cfg.cap_ms)::numeric / cfg.grace_block_ms)))
             * (case when q.qtype = 'tita' then 1.0
                     else 1 + 1.0 / greatest(jsonb_array_length(q.options) - 1, 1) end))
      into full_margin
    from unnest(ar.question_ids) as qid
    join questions q on q.id = qid
    join section_config cfg on cfg.section = q.section;
    full_margin := coalesce(nullif(full_margin, 0), 300);

    w := 2.0 / (n - 1);

    for i in 1 .. n - 1 loop
      for j in i + 1 .. n loop
        k   := least(ks[i], ks[j]);
        e_i := 1.0 / (1.0 + power(10, (elos[j] - elos[i])::numeric / 400.0));
        -- Rank order decides who beat whom, tiebreaks included (equal score
        -- but more correct / faster = a win at the minimum margin factor), so
        -- a higher finish never earns less than a lower one at equal ratings.
        -- Only a full tie is a draw.
        if scores[i] = scores[j] and corrects[i] = corrects[j] and times[i] = times[j] then
          -- draw: one shared delta from i's side (apply_draw)
          d := round(k * (0.5 - e_i) * w)::int;
        else
          -- i ranked above j = i beat j (apply_rated_result)
          f := F_MIN + (1.0 - F_MIN) * least((scores[i] - scores[j])::numeric / full_margin, 1.0);
          if elos[i] > elos[j] then
            f := f * 2.2 / (0.001 * (elos[i] - elos[j])::numeric + 2.2);
          end if;
          d := greatest(0, round(k * (1.0 - e_i) * f * w))::int;
        end if;
        -- 100 floor on whichever side pays, against the running total.
        if d >= 0 then
          d := least(d, greatest(elos[j] + deltas[j] - 100, 0));
        else
          d := -least(-d, greatest(elos[i] + deltas[i] - 100, 0));
        end if;
        deltas[i] := deltas[i] + d;
        deltas[j] := deltas[j] - d;
      end loop;
    end loop;
  end if;

  for i in 1 .. n loop
    update arena_players set elo_before = elos[i], elo_after = elos[i] + deltas[i]
    where arena_id = p_arena and user_id = uids[i];
    if deltas[i] <> 0 then
      update profiles set elo = elos[i] + deltas[i], peak_elo = greatest(peak_elo, elos[i] + deltas[i])
      where id = uids[i];
    end if;
    if any_skill then
      insert into rating_history (user_id, match_id, arena_id, elo_before, elo_after, delta)
      values (uids[i], null, p_arena, elos[i], elos[i] + deltas[i], deltas[i]);
    end if;
  end loop;

  update arenas set status = 'completed', ended_at = now() where id = p_arena;
end;
$$;
revoke all on function finalize_arena(uuid) from public, anon, authenticated;

-- ── arena_drain: fast-forward expired clocks (self-paced), finalize if done ──
-- Chained deadlines, as advance_timed_out: a vanished seat is drained to 9 in
-- one pass.
create or replace function arena_drain(p_arena uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar      arenas%rowtype;
  r       record;
  v_idx   int;
  v_start timestamptz;
  cap     int;
begin
  select * into ar from arenas where id = p_arena for update;
  if not found or ar.status <> 'active' then return; end if;

  for r in select * from arena_players where arena_id = p_arena loop
    select count(*) into v_idx from arena_answers where arena_id = p_arena and user_id = r.user_id;
    v_start := r.q_started;
    while v_idx < 9 and v_start is not null loop
      cap := question_cap_ms(ar.question_ids, v_idx);
      exit when cap is null;
      exit when now() < v_start + (cap || ' milliseconds')::interval;
      insert into arena_answers (arena_id, user_id, question_id, question_index,
                                 selected_index, is_correct, points_awarded, time_taken_ms)
      values (p_arena, r.user_id, ar.question_ids[v_idx + 1], v_idx, null, false, 0, null)
      on conflict do nothing;
      v_start := v_start + (cap || ' milliseconds')::interval;
      v_idx   := v_idx + 1;
    end loop;
    if v_start is distinct from r.q_started then
      update arena_players set q_started = v_start where arena_id = p_arena and user_id = r.user_id;
    end if;
  end loop;

  if not exists (
    select 1 from arena_players ap
    where ap.arena_id = p_arena
      and (select count(*) from arena_answers aa where aa.arena_id = p_arena and aa.user_id = ap.user_id) < 9
  ) then
    perform finalize_arena(p_arena);
  end if;
end;
$$;
revoke all on function arena_drain(uuid) from public, anon, authenticated;

-- ── arena_sweep: cron backstop ──────────────────────────────────────────────
create or replace function arena_sweep()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r record;
begin
  for r in select id from arenas where status = 'forming' and accept_deadline < now() loop
    perform arena_resolve_ready(r.id);
  end loop;
  for r in select id from arenas where status = 'active' loop
    perform arena_drain(r.id);
  end loop;
  -- Abandoned waiting tabs (client heartbeats every 3s).
  delete from arena_queue where status = 'waiting' and heartbeat_at < now() - interval '60 seconds';
end;
$$;
revoke all on function arena_sweep() from public, anon, authenticated;
select cron.schedule('arena-sweep', '* * * * *', 'select arena_sweep()');

-- ── arena_heartbeat: the client's one poll before the game starts ───────────
create or replace function arena_heartbeat()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid  uuid := auth.uid();
  ar   arenas%rowtype;
  qrow arena_queue%rowtype;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('arena_heartbeat', 30, 10);

  update arena_queue set heartbeat_at = now() where user_id = uid;

  select a.* into ar from arena_players ap join arenas a on a.id = ap.arena_id
  where ap.user_id = uid and not ap.declined and a.status in ('forming', 'active')
  order by a.created_at desc limit 1;

  if found and ar.status = 'forming' and now() > ar.accept_deadline then
    perform arena_resolve_ready(ar.id);
    ar := null;
  end if;

  if ar.id is null then
    perform try_arena_internal(uid);
    select a.* into ar from arena_players ap join arenas a on a.id = ap.arena_id
    where ap.user_id = uid and not ap.declined and a.status in ('forming', 'active')
    order by a.created_at desc limit 1;
  end if;

  if ar.id is not null and ar.status = 'active' then
    return jsonb_build_object('phase', 'active', 'arena_id', ar.id);
  end if;

  if ar.id is not null then
    return jsonb_build_object(
      'phase', 'ready',
      'arena_id', ar.id,
      'deadline', ar.accept_deadline,
      'server_now', now(),
      'me_accepted', (select accepted_at is not null from arena_players where arena_id = ar.id and user_id = uid),
      'players', (
        select jsonb_agg(jsonb_build_object(
                 'username', p.username, 'display_name', p.display_name,
                 'avatar_url', p.avatar_url, 'elo', p.elo,
                 'accepted', ap.accepted_at is not null, 'me', ap.user_id = uid)
               order by ap.seat)
        from arena_players ap join profiles p on p.id = ap.user_id
        where ap.arena_id = ar.id
      )
    );
  end if;

  select * into qrow from arena_queue where user_id = uid;
  if found then
    return jsonb_build_object(
      'phase', 'waiting',
      'enqueued_at', qrow.enqueued_at,
      'server_now', now(),
      'searching', (select count(*) from arena_queue
                    where status = 'waiting' and heartbeat_at > now() - interval '30 seconds')
    );
  end if;

  return jsonb_build_object('phase', 'idle');
end;
$$;
revoke all on function arena_heartbeat() from public, anon;
grant execute on function arena_heartbeat() to authenticated;

-- ── get_arena_question (mirrors get_match_question's self-paced branch) ─────
create or replace function get_arena_question(p_arena uuid, p_index smallint)
returns table(question_id uuid, section cat_section, body text, options jsonb,
              qtype text, cap_ms integer, started_at timestamptz,
              passage text, image_url text, passage_image_url text)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar        arenas%rowtype;
  me        arena_players%rowtype;
  q         questions%rowtype;
  perm      integer[];
  shuffled  jsonb;
  v_passage text;
  v_pimage  text;
  v_myidx   int;
begin
  select * into ar from arenas where id = p_arena;
  if not found then raise exception 'forbidden'; end if;
  select * into me from arena_players where arena_id = p_arena and user_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  if ar.status <> 'active' then raise exception 'arena not active'; end if;

  select count(*) into v_myidx from arena_answers where arena_id = p_arena and user_id = auth.uid();
  if p_index <> v_myidx then raise exception 'not current question'; end if;

  select * into q from questions where id = ar.question_ids[p_index + 1];

  if q.qtype = 'tita' then
    shuffled := '[]'::jsonb;
  else
    perm := option_perm(p_arena, auth.uid(), p_index, jsonb_array_length(q.options));
    select jsonb_agg(q.options -> p order by ord) into shuffled
    from unnest(perm) with ordinality as u(p, ord);
  end if;

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id, q.section, q.body, shuffled, q.qtype,
    question_cap_ms(ar.question_ids, p_index::int),
    me.q_started,
    v_passage, q.image_url, v_pimage;
end;
$$;
revoke all on function get_arena_question(uuid, smallint) from public, anon;
grant execute on function get_arena_question(uuid, smallint) to authenticated;

-- ── arena_submit_answer — scoring copied from submit_answer (20260718010000) ─
-- KEEP IN LOCKSTEP with submit_answer's scoring block. Differences, all
-- deliberate: the clock is the caller's arena_players.q_started; no
-- fast_answer telemetry (match_events.match_id references matches); the
-- question-ELO nudge always applies (arenas are always rated).
-- Returns the reveal for the caller's own answer only (correct + points); the
-- canonical key is never returned, same as the 1v1 path.
create or replace function arena_submit_answer(p_arena uuid, p_question_index smallint,
                                               p_selected_index smallint, p_answer_text text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar         arenas%rowtype;
  me         arena_players%rowtype;
  q          questions%rowtype;
  cfg        section_config%rowtype;
  uid        uuid := auth.uid();
  cap        integer;
  cap_base   integer;
  taken_ms   integer;
  v_correct  boolean;
  grace      integer;
  pts        integer;
  n_opts     integer;
  perm       integer[];
  canonical  smallint;
  v_answer   text;
  answered   boolean;
  player_elo integer;
  res_q      numeric;
  suspect    boolean;
  late       boolean;
  inserted   int;
  v_myidx    int;
begin
  perform check_rate_limit('submit_answer', 20, 5);

  -- Arena row lock serialises the seats' submits, so the "everyone has 9"
  -- check below can't be missed by two concurrent final answers.
  select * into ar from arenas where id = p_arena for update;
  if not found or ar.status <> 'active' then raise exception 'arena not active'; end if;
  select * into me from arena_players where arena_id = p_arena and user_id = uid;
  if not found then raise exception 'not a participant'; end if;

  select count(*) into v_myidx from arena_answers where arena_id = p_arena and user_id = uid;
  if p_question_index <> v_myidx then raise exception 'stale question'; end if;

  select * into q   from questions where id = ar.question_ids[p_question_index + 1];
  select * into cfg from section_config where section = q.section;
  cap_base := coalesce(q.duration_ms, cfg.cap_ms);
  cap      := question_cap_ms(ar.question_ids, p_question_index::int);
  n_opts   := jsonb_array_length(q.options);

  taken_ms := greatest(0, least(cap, (extract(epoch from (now() - me.q_started)) * 1000)::int));
  late     := (extract(epoch from (now() - me.q_started)) * 1000) > cap + 3000;
  grace    := round(cfg.speed_mult * floor(least(cap - taken_ms, cap_base)::numeric / cfg.grace_block_ms))::int;

  if q.qtype = 'tita' then
    canonical := null;
    if late or tita_norm(p_answer_text) is null then
      v_answer := null;
    else
      v_answer := btrim(p_answer_text);
    end if;
    v_correct := (v_answer is not null and tita_matches(v_answer, q.answer_value));
    pts := case
      when late or v_answer is null then 0
      when v_correct                  then cfg.base_points + grace
      else                               0
    end;
  else
    v_answer := null;
    if p_selected_index is null or late then
      canonical := null;
    elsif p_selected_index < 0 or p_selected_index >= n_opts then
      raise exception 'invalid option';
    else
      perm      := option_perm(p_arena, uid, p_question_index, n_opts);
      canonical := perm[p_selected_index + 1];
    end if;
    v_correct := (canonical is not null and canonical = q.correct_index);
    pts := case
      when late               then 0
      when v_correct            then cfg.base_points + grace
      when canonical is null  then 0
      else                         -round((cfg.base_points + grace)::numeric
                                          / greatest(n_opts - 1, 1))::int
    end;
  end if;

  answered := (canonical is not null or v_answer is not null);

  insert into arena_answers (arena_id, user_id, question_id, question_index,
                             selected_index, answer_text, is_correct, points_awarded, time_taken_ms)
  values (p_arena, uid, q.id, p_question_index, canonical, v_answer, v_correct, pts, taken_ms)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then raise exception 'already answered'; end if;

  -- Own clock for the next question (+3s reveal lead-in, as submit_answer).
  update arena_players set
    score     = score + pts,
    correct   = correct + case when v_correct then 1 else 0 end,
    time_ms   = time_ms + case when v_correct then taken_ms else 0 end,
    q_started = now() + interval '3 seconds'
  where arena_id = p_arena and user_id = uid;

  suspect := (answered and taken_ms < 2000);
  if answered and not suspect then
    select elo into player_elo from profiles where id = uid;
    res_q := case when v_correct then 0.35 * (taken_ms::numeric / greatest(cap, 1)) else 1.0 end;
    update questions
      set elo = greatest(400, least(2800, round(elo
                  + (case when times_seen < 20 then 32 else 16 end)
                  * (res_q - 1.0 / (1.0 + power(10.0, (player_elo - elo) / 400.0))))::int)),
          times_seen = times_seen + 1
      where id = q.id;
  else
    update questions set times_seen = times_seen + 1 where id = q.id;
  end if;

  if p_question_index = 8 and not exists (
    select 1 from arena_players ap
    where ap.arena_id = p_arena
      and (select count(*) from arena_answers aa where aa.arena_id = p_arena and aa.user_id = ap.user_id) < 9
  ) then
    perform finalize_arena(p_arena);
  end if;

  return jsonb_build_object('correct', v_correct, 'points', pts);
end;
$$;
revoke all on function arena_submit_answer(uuid, smallint, smallint, text) from public, anon;
grant execute on function arena_submit_answer(uuid, smallint, smallint, text) to authenticated;

-- ── get_arena_state: standings (progress live, scores only once completed) ──
create or replace function get_arena_state(p_arena uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ar   arenas%rowtype;
  done boolean;
begin
  if not exists (select 1 from arena_players where arena_id = p_arena and user_id = auth.uid()) then
    raise exception 'forbidden';
  end if;
  perform check_rate_limit('get_arena_state', 40, 10);

  -- Self-healing: any participant's poll drains expired clocks, so a vanished
  -- seat never holds the lobby hostage for the cron minute.
  perform arena_drain(p_arena);

  select * into ar from arenas where id = p_arena;
  done := ar.status = 'completed';

  return jsonb_build_object(
    'status', ar.status,
    'server_now', now(),
    'players', (
      select jsonb_agg(jsonb_build_object(
               'username', p.username, 'display_name', p.display_name, 'avatar_url', p.avatar_url,
               'me', ap.user_id = auth.uid(),
               'answered', (select count(*) from arena_answers aa where aa.arena_id = p_arena and aa.user_id = ap.user_id),
               'score',     case when done or ap.user_id = auth.uid() then ap.score end,
               'correct',   case when done or ap.user_id = auth.uid() then ap.correct end,
               'rank',      case when done then ap.rank end,
               'elo_before', case when done then ap.elo_before end,
               'elo_after',  case when done then ap.elo_after end)
             order by case when done then ap.rank else ap.seat end)
      from arena_players ap join profiles p on p.id = ap.user_id
      where ap.arena_id = p_arena
    )
  );
end;
$$;
revoke all on function get_arena_state(uuid) from public, anon;
grant execute on function get_arena_state(uuid) to authenticated;

-- ── get_profile: arena rating rows are not season resets ────────────────────
-- From the latest def (20260719000000_prelaunch_gaps), one expression changed.
create or replace function get_profile(p_username text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'rank', (
      select count(*) + 1
      from profiles p2
      where p2.elo > p.elo
    ),
    'curve', (
      select coalesce(jsonb_agg(
        jsonb_build_object('elo', rh.elo_after, 'at', rh.created_at,
                           'delta', rh.delta, 'reset', rh.match_id is null and rh.arena_id is null)
        order by rh.created_at
      ), '[]')
      from rating_history rh where rh.user_id = p.id
    )
  )
  from profiles p where p.username = p_username;
$$;

-- ── join_queue: refuse while busy in an arena ───────────────────────────────
-- From the latest def (20260714140000_matchmaking_stats_fixes), one guard added.
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
  if in_live_arena(auth.uid()) then
    raise exception 'already in an arena';
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


-- ── arena_busy: the caller-scoped read lib/ai/live-match.ts uses ────────────
-- The arena tables are definer-only, so inLiveMatch can't read them through
-- RLS like it reads matches. Caller-scoped (no uid arg) so it leaks nothing
-- about anyone else.
create or replace function arena_busy()
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select in_live_arena(auth.uid());
$$;
revoke all on function arena_busy() from public, anon;
grant execute on function arena_busy() to authenticated;

-- ── accept_challenge: refuse while either side is busy in an arena ──────────
-- From the latest def (20260719040000_accept_challenge_live_match_guard), one
-- guard pair added after the live-match guards. Signature unchanged.
create or replace function accept_challenge(p_code text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
  target    int;
  players   uuid[];
  v_seen    uuid[];
  n_varc    int;
  n_dilr    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  -- Mirror join_queue's live-match guard, for both players: the sweep in
  -- advance_timed_out flips stale pending matches to 'abandoned', so any
  -- ('active','pending') row here is genuinely live.
  if exists (
    select 1 from matches
    where (player_a = auth.uid() or player_b = auth.uid())
      and status in ('active', 'pending')
  ) then
    raise exception 'already in a live match';
  end if;
  if exists (
    select 1 from matches
    where (player_a = ch.host_id or player_b = ch.host_id)
      and status in ('active', 'pending')
  ) then
    raise exception 'challenger is in another match';
  end if;
  if in_live_arena(auth.uid()) then
    raise exception 'already in an arena';
  end if;
  if in_live_arena(ch.host_id) then
    raise exception 'challenger is in an arena';
  end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();
  target  := ((host_elo + me_elo) / 2)::int;
  players := array[ch.host_id, auth.uid()];

  if ch.section_mode is null then
    -- Mixed: a section with < 3 active questions contributes 0 slots that roll
    -- into QUANT (mirrors try_match_internal / match_with_bot).
    n_varc := case when (select count(*) from questions where section = 'VARC' and is_active) >= 3 then 3 else 0 end;
    n_dilr := case when (select count(*) from questions where section = 'DILR' and is_active) >= 3 then 3 else 0 end;

    q_ids := case when n_varc = 3 then coalesce(pick_section_question_ids('VARC', target, players), '{}') else '{}' end
          || case when n_dilr = 3 then coalesce(pick_section_question_ids('DILR', target, players), '{}') else '{}' end
          || coalesce(pick_quant_question_ids(target, 9 - n_varc - n_dilr, players), '{}');
  elsif ch.section_mode = 'QUANT' then
    -- Same 1-in-3 quota as a mixed match: 3 TITA of 9.
    q_ids := coalesce(pick_quant_question_ids(target, 9, players), '{}');
  else
    select coalesce(array_agg(distinct a.question_id), '{}')
      into v_seen
    from match_answers a
    where a.user_id = any(players);

    select array_agg(t.id) into q_ids from (
      select q.id from questions q
      where q.section = ch.section_mode and q.is_active
      order by (q.id = any(v_seen))::int,
               abs(q.elo - target) + random() * 300
      limit 9
    ) t;
  end if;

  -- Never create a truncated match — a < 9 question_ids array corrupts mid-play.
  if coalesce(array_length(q_ids, 1), 0) <> 9 then
    raise exception 'not enough active questions for this challenge';
  end if;

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;

revoke all on function accept_challenge(text) from public, anon;
grant execute on function accept_challenge(text) to authenticated, service_role;
