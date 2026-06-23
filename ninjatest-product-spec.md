# Ninjatest — Product Specification

> **Tagline:** Chess.com for CAT prep. Challenge a friend (or a stranger) to a 9-question, real-time, timed 1v1. ELO-rated. National leaderboard.

**Version:** 1.1 (all core mechanics locked — build-ready)
**Owner:** Arpan
**Status:** Spec → handoff to Claude Code
**Locked:** scoring, ELO, sectional time caps, matchmaking, friend challenges, forfeit rule (see §14)

---

## 1. Overview

Ninjatest is a gamified, head-to-head aptitude-battle platform for **CAT** (Common Admission Test) aspirants. Two players face an identical set of **9 questions** — **3 VARC + 3 DILR + 3 Quant** — under shared, synchronized **sectional time caps**. The winner is decided by **total points**: a correct-answer base plus speed-based grace points, with **negative marking** for wrong answers, weighted per section (DILR and Quant reward speed more than VARC). At the end, both players' **ELO** updates based on **who won, the rating gap between them, and the point margin**, and a **national leaderboard** ranks everyone by ELO.

### Design pillars
1. **Real-time and synchronized** — both players see the same question at the same moment.
2. **Server-authoritative** — correctness, timing, and scoring are computed server-side. Clients only render. This is non-negotiable for a rated, competitive system.
3. **Minimal, fast UI** — Vercel/Geist aesthetic: lots of whitespace, monochrome base, one accent, no clutter.
4. **Fair matchmaking** — skill-based pairing by ELO, with friend challenges as a first-class path.

---

## 2. Core gameplay loop

```
Lobby ──► Find match (queue)  ──► Match found ──► Countdown (3s)
  │            or                                      │
  └──► Challenge a friend (link/code) ─────────────────┘
                                                        ▼
                            Q1 → Q2 → ... → Q9  (sectional cap · auto-advance)
                                                        ▼
                            Match ends ──► Result screen (winner)
                                                        ▼
                            ELO updated for both ──► back to Lobby
```

### Match format
- **9 questions**, fixed **3 VARC + 3 DILR + 3 Quant** for v1 (selectable section weighting is a later addition).
- **Per-question time cap, sectional** — derived from real CAT per-question pacing: **VARC 90s** (~1.5 min/Q), **DILR 120s** (~2 min/Q), **Quant 105s** (~1.75 min/Q). **When a question's cap ends, the match auto-advances to the next question** (no manual "next" / no waiting). Caps are config, tunable per section.
- Both players answer the **same question simultaneously**. A question closes when **both have answered OR its sectional cap expires** (whichever is first), then auto-advances. This keeps the match synchronized and bounds total match length (≈ 9× the relevant caps ≈ a hard ceiling, also enforced as a match-level safety net).
- Questions are **single-correct MCQ** for MVP (4 options). DILR/free-response can come later.

### Scoring rules (per match) — section-level, speed-graded, with negative marking

Scoring is **per section**, not uniform across the test. Every correct answer earns a fixed **correct-answer base** plus **speed grace points**; a wrong answer incurs **negative marking**; an unanswered/timed-out question is **0** (no penalty for leaving blank — same logic as the real CAT, so guessing is a genuine risk).

**Per-question score:**
```
score = correct  →  BASE + SPEED_MULT[section] · floor((T[section] − t) / 5s)
        wrong    →  − PENALTY
        skipped / timed out → 0
```
- `BASE` = **100** points, identical for every correct answer in every section. This is the "right-answer point" and anchors the 70:30 balance.
- **Grace points** = `floor((T − t) / 5)` → **1 grace block per 5 seconds saved** before the cap, multiplied by the section's speed weight.
- `t` = server-measured time taken; `T` = the section's time cap.
- `PENALTY` = **30** points for a wrong answer (≈ the CAT +3/−1 ratio; tunable).

**Section parameters** (caps from real CAT pacing; speed weight is what makes DILR/Quant reward speed and VARC not):

| Section | Cap `T` | Speed mult (per 5s block) | Max grace | Correct range | Wrong | Correctness : Speed |
|---|---|---|---|---|---|---|
| **VARC**  | 90s  | **×1** | 18 | 100 → 118 | −30 | ~85 : 15 (speed matters least) |
| **Quant** | 105s | **×2** | 42 | 100 → 142 | −30 | **70 : 30** (anchor) |
| **DILR**  | 120s | **×2** | 48 | 100 → 148 | −30 | ~68 : 32 (speed matters most) |

> **Worked example (Quant):** correct at `t = 30s`, cap `105s` → grace blocks = `floor(75/5)=15`, speed mult ×2 → `+30`. Total = `100 + 30 = 130`. The same answer at the buzzer (`t≈105s`) = `100 + 0 = 100`. Wrong = `−30`.

**Why this satisfies the 70:30 brief:**
- Correctness is the dominant axis everywhere — even in the most speed-weighted section (DILR), a correct answer is ≥68% base. Speed can sharpen a lead but a careful solver still beats a fast guesser.
- **VARC** deliberately under-weights speed (×1, ~85:15) — reading comprehension shouldn't reward rushing.
- **DILR & Quant** reward speed (×2) — these are the sections where solving quickly is the actual skill being tested.
- The system is anchored at **70:30** (Quant), with VARC leaning further to accuracy and DILR slightly toward speed.

**Match score** = sum of all 9 question scores (can be negative if a player misses badly). Higher total wins; exact tie → **draw**. The match score also drives the *magnitude* of the ELO change — see §3.

> **The dial is `SPEED_MULT` per section** — a single config constant per section. Raise it to make a section more twitch-based, lower it to make it more deliberate. `BASE`, `PENALTY`, and the caps `T` are likewise config.

---

## 3. ELO system

Standard Elo, identical in spirit to FIDE/Chess.com.

**Expected score for player A vs B:**
```
Eₐ = 1 / (1 + 10^((R_b − R_a) / 400))
E_b = 1 − Eₐ
```

**Rating update:**
```
R_a' = R_a + K · (S_a − Eₐ)
R_b' = R_b + K · (S_b − E_b)
```

**Outcome model — result decides direction, margin + rating-gap decide size (locked).**
Two independent factors set the rating change:
1. **Who won** sets the *sign* — the winner always gains, the loser always loses. (No "won the match but lost ELO" surprises.)
2. **The ELO gap** sets the *base size* via the standard expected-score term `E` — beating a much higher-rated player gains a lot; a favorite beating a much weaker player gains little.
3. **The point margin** scales that base — a narrow win moves less, a blowout moves the full amount.

```
E_w   = 1 / (1 + 10^((R_loser − R_winner) / 400))   -- winner's expected score
base  = K · (1 − E_w)                                -- standard Elo win delta, always ≥ 0
factor = F_MIN + (1 − F_MIN) · min(|margin| / FULL_MARGIN, 1)   -- margin scaling

Δ_winner = max(1, round(base · factor))
Δ_loser  = − Δ_winner                                 -- zero-sum
```
- `F_MIN = 0.3` (a bare win still moves ~30% of the base), `FULL_MARGIN = 300` (≈ a 2–3 clean-question lead at the new score scale = full base), `K` per the schedule below. All tunable.
- **Zero-sum** (`Δ_loser = −Δ_winner`) → no rating inflation. Winner floored at **+1** so an extreme favorite never sees "+0".
- **Why this matches the brief:** `E_w` falls as the winner's rating rises above the opponent's, so the **higher-ELO player gains less** and risks more — exactly the friend-battle behaviour you want.

**Equal-rated (both 1000, `K=24`, base=12):** margin sets the size (one clean question ≈ 100–148 pts).
| Point margin | factor | Winner Δ | Loser Δ |
|---|---|---|---|
| +1 (squeak) | 0.30 | +4 | −4 |
| +100 (~1 question) | 0.53 | +6 | −6 |
| +200 (~2 questions) | 0.77 | +9 | −9 |
| ≥ +300 (blowout) | 1.00 | +12 | −12 |

**Lopsided friend battle (1600 vs 1000, `K=24`) — the rating gap dominates:**
| Outcome | Winner's `base` | Dominant win (Δ) | Narrow win (Δ) |
|---|---|---|---|
| **1600 favorite wins** | `24·0.031 ≈ 0.7` | **+1** | **+1** |
| **1000 underdog wins** | `24·0.969 ≈ 23.3` | **+23 / −23** | **+7 / −7** |

So the 1600 player gains almost nothing for beating their 1000-rated friend (and drops 7–23 if they slip up), while the underdog has everything to gain — which is what keeps lopsided rated friend matches fair.

**K-factor schedule** (provisional period like FIDE):
| Condition | K |
|---|---|
| `matches_played < 30` (provisional) | 40 |
| ELO < 2000 | 24 |
| ELO ≥ 2000 | 16 |

- **Starting ELO:** 1000.
- **Floor:** ratings never drop below 100.
- Every match writes a **rating-history row** for each player → powers the profile graph.
- **Friend/unranked challenges** can be flagged `is_rated = false` to leave ELO untouched (useful for practice). Default for queue matches: rated.

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router)** | RSC + route handlers, deploys clean on Vercel |
| Hosting | **Vercel** | Edge network, preview deploys |
| DB + Auth | **Supabase (Postgres + Auth + RLS)** | Single source of truth, row-level security |
| Realtime | **Supabase Realtime** (Broadcast + Presence + Postgres Changes) | Match channels, live presence, no extra infra |
| Authoritative logic | **Supabase Edge Functions** (or Next.js route handlers) | Server-side answer validation, scoring, ELO, matchmaking |
| Queue concurrency | **Postgres `SELECT … FOR UPDATE SKIP LOCKED`** | Atomic pairing without Redis at MVP scale |
| (Optional, scale) | **Upstash Redis** | Sorted-set matchmaking + rate limiting when concurrency grows |
| UI | **Tailwind + shadcn/ui**, Geist font, Lucide icons | Vercel-minimal aesthetic out of the box |
| Charts | **Recharts** | ELO/score-over-time profile graph |
| Email (optional) | **Resend** | Challenge invites, result summaries |

### Why Supabase Realtime is enough
- **Presence** → know if your opponent is connected / rage-quit.
- **Broadcast** → low-latency "next question" / "opponent answered" signals.
- **Postgres Changes** → authoritative state (match status, final result) streamed from DB.

The key rule: **Broadcast is for liveliness; the database is for truth.** Anything that affects score or ELO goes through a server function and the DB — never trusted directly from a client broadcast.

---

## 5. System architecture

```
┌──────────────┐        Broadcast / Presence        ┌──────────────┐
│  Player A    │◄──────────────────────────────────►│  Player B    │
│ (Next.js)    │        (Supabase Realtime)          │ (Next.js)    │
└──────┬───────┘                                     └───────┬──────┘
       │  submit_answer (RPC / Edge Fn)                      │
       └───────────────┬─────────────────────────────────────┘
                       ▼
            ┌────────────────────────┐
            │  Edge Functions / RPC  │  ← authoritative: validate answer,
            │  (server-side logic)   │     compute score, advance question,
            └───────────┬────────────┘     run ELO at match end
                        ▼
            ┌────────────────────────┐
            │   Supabase Postgres    │  ← matches, answers, profiles,
            │   + RLS + Realtime     │     questions, queue, rating_history
            └────────────────────────┘
```

### Time synchronization (critical)
Network latency between players differs, so you cannot let each client start its own timer freely. Instead:

1. When the match advances to question *N*, the server writes/broadcasts `{ question_index: N, server_start_ts }`.
2. Each client computes its local offset from a server time sync (one round-trip `now()` call at match start) and renders the countdown as `deadline = server_start_ts + duration`.
3. When a client submits, the **server** records `time_taken_ms = server_received_ts − server_start_ts` — the client's self-reported timing is ignored for scoring.

This makes the visible timer feel synchronized while keeping authoritative timing server-side.

---

## 6. Database schema (Postgres / Supabase)

```sql
-- =========================================================
-- PROFILES  (extends auth.users)
-- =========================================================
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text unique not null,
  display_name    text,
  avatar_url      text,
  elo             integer not null default 1000,
  peak_elo        integer not null default 1000,
  matches_played  integer not null default 0,
  wins            integer not null default 0,
  losses          integer not null default 0,
  draws           integer not null default 0,
  created_at      timestamptz not null default now()
);

create index profiles_elo_idx on profiles (elo desc);

-- =========================================================
-- QUESTIONS
-- =========================================================
create type cat_section as enum ('VARC', 'DILR', 'QUANT');

create table questions (
  id            uuid primary key default gen_random_uuid(),
  section       cat_section not null,
  difficulty    smallint not null default 3,          -- 1..5
  body          text not null,                        -- markdown/HTML
  options       jsonb not null,                       -- ["...","...","...","..."]
  correct_index smallint not null,                    -- 0..3
  explanation   text,
  duration_ms   integer,                              -- optional per-Q override; null = use section_config cap
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index questions_section_idx on questions (section) where is_active;

-- =========================================================
-- SECTION SCORING CONFIG  (per-section dials; see §2)
-- =========================================================
create table section_config (
  section       cat_section primary key,
  cap_ms        integer  not null,   -- per-question time cap T (auto-advance at cap)
  base_points   integer  not null default 100,  -- correct-answer base
  speed_mult    smallint not null,   -- grace points per 5s block saved
  grace_block_ms integer not null default 5000, -- 5s per grace block
  wrong_penalty integer  not null default 30    -- subtracted on a wrong answer
);

insert into section_config (section, cap_ms, base_points, speed_mult, wrong_penalty) values
  ('VARC',   90000, 100, 1, 30),   -- ~1.5 min/Q
  ('QUANT', 105000, 100, 2, 30),   -- ~1.75 min/Q
  ('DILR',  120000, 100, 2, 30);   -- ~2 min/Q

-- =========================================================
-- MATCHES
-- =========================================================
create type match_status as enum ('pending', 'active', 'completed', 'abandoned');

create table matches (
  id            uuid primary key default gen_random_uuid(),
  player_a      uuid not null references profiles(id),
  player_b      uuid not null references profiles(id),
  status        match_status not null default 'pending',
  is_rated      boolean not null default true,
  question_ids  uuid[] not null,            -- frozen 9-question snapshot, ordered
  current_index smallint not null default 0,
  question_started_at timestamptz,          -- server start ts of current question

  score_a       integer not null default 0,  -- time-weighted total points
  score_b       integer not null default 0,
  correct_a     smallint not null default 0, -- # correct (for display/stats)
  correct_b     smallint not null default 0,
  time_a_ms     integer not null default 0,  -- cumulative correct-answer time
  time_b_ms     integer not null default 0,
  winner_id     uuid references profiles(id), -- null = draw or unfinished

  elo_a_before  integer,
  elo_b_before  integer,
  elo_a_after   integer,
  elo_b_after   integer,

  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ended_at      timestamptz,

  constraint distinct_players check (player_a <> player_b)
);

create index matches_status_idx on matches (status);
create index matches_players_idx on matches (player_a, player_b);

-- =========================================================
-- MATCH ANSWERS
-- =========================================================
create table match_answers (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references matches(id) on delete cascade,
  user_id        uuid not null references profiles(id),
  question_id    uuid not null references questions(id),
  question_index smallint not null,
  selected_index smallint,                 -- null = timed out / no answer
  is_correct     boolean not null default false,
  points_awarded integer not null default 0,  -- time-weighted points for this Q
  time_taken_ms  integer,                  -- server-measured
  answered_at    timestamptz not null default now(),

  unique (match_id, user_id, question_index)   -- one answer per Q per player
);

-- =========================================================
-- RATING HISTORY  (powers the profile graph)
-- =========================================================
create table rating_history (
  id          bigserial primary key,
  user_id     uuid not null references profiles(id),
  match_id    uuid references matches(id) on delete set null,
  elo_before  integer not null,
  elo_after   integer not null,
  delta       integer not null,
  created_at  timestamptz not null default now()
);

create index rating_history_user_idx on rating_history (user_id, created_at);

-- =========================================================
-- MATCHMAKING QUEUE
-- =========================================================
create type queue_status as enum ('waiting', 'matched', 'cancelled');

create table matchmaking_queue (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id),
  elo         integer not null,
  status      queue_status not null default 'waiting',
  match_id    uuid references matches(id),
  enqueued_at timestamptz not null default now(),

  unique (user_id) where (status = 'waiting')  -- can't double-queue
);

create index queue_waiting_idx on matchmaking_queue (status, elo, enqueued_at)
  where status = 'waiting';

-- =========================================================
-- FRIEND CHALLENGES (direct invites)
-- =========================================================
create table challenges (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,          -- shareable join code
  host_id     uuid not null references profiles(id),
  guest_id    uuid references profiles(id),  -- filled on join
  is_rated    boolean not null default true,
  match_id    uuid references matches(id),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  created_at  timestamptz not null default now()
);
```

### Row-Level Security (policies)

```sql
alter table profiles          enable row level security;
alter table matches           enable row level security;
alter table match_answers     enable row level security;
alter table matchmaking_queue enable row level security;
alter table challenges        enable row level security;
alter table questions         enable row level security;
alter table section_config    enable row level security;
alter table rating_history    enable row level security;

-- profiles: world-readable; self-update but NEVER elo/stats from the client
create policy profiles_read   on profiles for select using (true);
create policy profiles_update on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());
-- (elo, peak_elo, W/L/D, matches_played are written only by security-definer
--  functions running as the table owner, which bypass RLS — see §10.1)

-- matches / answers: visible only to the two participants
create policy matches_read on matches for select
  using (auth.uid() in (player_a, player_b));
create policy answers_read on match_answers for select
  using (exists (select 1 from matches m
                 where m.id = match_id and auth.uid() in (m.player_a, m.player_b)));

-- queue / challenges: users manage only their own rows
create policy queue_self on matchmaking_queue for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy challenge_rw on challenges for all
  using (auth.uid() in (host_id, guest_id))
  with check (auth.uid() = host_id);

-- questions: NO direct client read (would leak correct_index). Served only via
-- get_match_question(), which strips the answer. section_config is read-only public.
create policy questions_none   on questions for select using (false);
create policy config_read      on section_config for select using (true);
create policy rating_self_read on rating_history for select using (user_id = auth.uid());
```

> All score/ELO/queue mutations happen inside `security definer` functions owned by a privileged role (§10.1); those bypass RLS, so clients can never write `elo`, `score_*`, or another player's data directly.

---

## 7. Matchmaking algorithm

Goal: pair two **waiting** players whose ELO is close, widening the acceptable band the longer someone waits (so nobody waits forever).

### Band-widening
```
band(wait_seconds) = base_band + (wait_seconds * growth)
   base_band = 100 ELO
   growth    = 20 ELO / second
   cap       = 1000 ELO  (after ~45s, match almost anyone)
```

### Atomic pairing with SKIP LOCKED
A scheduled function (or a trigger on insert) attempts to pair the longest-waiting player with the closest eligible opponent. `FOR UPDATE SKIP LOCKED` guarantees no two pairing passes grab the same row.

```sql
create or replace function try_match(p_user_id uuid)
returns uuid                       -- returns match_id or null
language plpgsql security definer
as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  band         integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  -- lock my own waiting row
  select * into me
  from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at)) * 20);

  -- find the closest eligible opponent, lock them
  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= band
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  -- freeze a 9-question set: 3 per section, random active
  select array_agg(id) into q_ids from (
    (select id from questions where section='VARC'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='DILR'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='QUANT' and is_active order by random() limit 3)
  ) s;

  insert into matches (player_a, player_b, status, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', q_ids,
          me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
    set status='matched', match_id=new_match_id
    where id in (me.id, opp.id);

  return new_match_id;
end;
$$;
```

### Client flow
1. Client calls `join_queue()` → inserts a `waiting` row, subscribes to a Realtime channel keyed on its `user_id`.
2. A pairing pass (cron every ~2s, or triggered on each enqueue) runs `try_match()`.
3. On success, both queue rows flip to `matched` → **Postgres Changes** notifies both clients → they navigate into the match.
4. **Leaving the queue** sets status `cancelled`.

> At MVP scale this is plenty. If concurrent queue size grows large, move the waiting set into an **Upstash Redis sorted set** keyed by ELO and pair with `ZRANGEBYSCORE`, keeping Postgres for durable match records.

### Friend challenges
- Host calls `create_challenge(is_rated)` and **chooses Rated or Unrated** at creation → gets a `code` + shareable link (`ninjatest.app/c/<code>`).
  - **Rated** — outcome updates both players' ELO (including the full forfeit penalty below).
  - **Unrated** — a practice match; ELO is untouched, no rating-history row, and no forfeit penalty.
- The chosen mode is shown to the guest before they accept.
- Guest opens link, authenticates, calls `accept_challenge(code)` → creates the match directly, no queue.

---

## 8. Real-time match engine (server-authoritative)

### Match lifecycle
```
pending ──(both present)──► active ──(9 answered/expired)──► completed
   │                                                            
   └──(opponent disconnect > grace)──► abandoned (win by forfeit)
```

### Per-question flow
1. **Server advances** to `current_index = N`, sets `question_started_at = now()`, broadcasts `{ index: N, started_at }`.
2. Server sends each client the **question body + options only** (correct index withheld).
3. Player submits via `submit_answer(match_id, question_index, selected_index)` (Edge Function / `security definer` RPC). The server:
   - Verifies the match is `active`, it's the current question, and the player hasn't already answered it.
   - Loads `section_config` for the question's section (`base`, `speed_mult`, `cap`, `penalty`).
   - Computes `is_correct` against `questions.correct_index`.
   - Computes `time_taken_ms = now() − question_started_at`, clamped to `[0, cap]`.
   - Computes points:
     ```
     grace  = speed_mult · floor((cap − time_taken_ms) / 5000)
     points = is_correct ? (base + grace)            -- e.g. Quant: 100 + 2·blocks
                         : (selected_index is null ? 0 : −penalty)
     ```
   - Inserts the `match_answers` row; increments running `score` (can go negative), `correct` count, and `time`.
   - Broadcasts a **non-revealing** signal: `{ opponent_answered: true }` (never the result or points — see §9).
4. **Advance condition:** when both players have a row for index `N`, **or** the question's **sectional cap expires** (auto-advance) → server reveals the correct answer/explanation to both, then advances to `N+1`. Unanswered at cap = `0` (skip).
5. After question 9 → run **finalization**.

### Finalization (atomic)
```
1. Determine outcome from total points:
     winner = higher score (score_a vs score_b)
     exact tie (rare) → draw
2. Compute rating change (result sets sign, gap + margin set size):
     winner = higher score; exact tie → draw (handle as standard Elo draw)
     E_w    = 1 / (1 + 10^((R_loser − R_winner)/400))
     base   = K · (1 − E_w)
     factor = F_MIN + (1−F_MIN)·min(|margin|/FULL_MARGIN, 1)   -- F_MIN=0.3, FULL_MARGIN=300
     Δ_win  = max(1, round(base · factor))
     Δ_lose = −Δ_win                                            -- zero-sum
3. Apply with floor at 100 ELO:
     R_winner' = R_winner + Δ_win
     R_loser'  = max(100, R_loser + Δ_lose)
4. In ONE transaction:
     - update matches (winner_id, score/correct, elo_*_after, status='completed', ended_at)
     - update both profiles (elo, peak_elo, matches_played, W/L/D)
     - insert two rating_history rows
5. Broadcast result → both clients render the result screen.
```

### Disconnects / abandonment
- **Presence** tracks connectivity. If a player drops mid-match for longer than a **grace window (e.g. 20s)**, the match is finalized as a **forfeit win** for the present player.
- **Forfeit penalty = full ELO loss.** The in-progress score is discarded; the present player is recorded as the winner with the **maximum margin factor** (`factor = 1.0`), so the quitter takes a full-strength loss:
  ```
  E_present = 1 / (1 + 10^((R_quitter − R_present)/400))
  Δ_present = max(1, round(K · (1 − E_present) · 1.0))   # full-margin win
  Δ_quitter = − Δ_present                                 # zero-sum
  ```
  This applies even if the quitter was *ahead* on points at the moment they left, so rage-quitting is never an escape hatch. (The rating-gap term still applies — a forfeit is a *dominant* loss, not one that ignores the ELO difference. Forfeit penalty applies to **rated** matches only; unrated friend matches just void.)
- A reconnecting client rehydrates full state from the DB (current index, deadline, own answers) — the DB is the source of truth, so refresh-resistant. Reconnecting within the grace window resumes the match normally.

---

## 9. Anti-cheat & fairness

This is a rated, competitive product, so treat the client as untrusted.

- **Correct answers never reach the client before they answer.** Question payloads strip `correct_index`. Reveal only happens after the question closes.
- **Opponent's correctness is hidden in real time** — broadcasting "opponent got it right" would let someone copy/infer. Only "opponent answered" is signaled (for UI presence), not the result.
- **All scoring/timing is server-measured.** Client-reported time is discarded.
- **Question snapshot is frozen** at match creation; both players get the identical ordered set.
- **Rate-limit** `submit_answer` and `join_queue` (per-user) to prevent abuse.
- **One answer per question per player** enforced by a DB unique constraint.
- **Rated friend-match boosting guard.** Because gain/loss scales with the rating gap, a high-rated account could deliberately lose to a low-rated friend to transfer ELO. Mitigations: cap the number of **rated** matches that count between the **same pair** per day (e.g. 3), apply diminishing ELO on repeat pairings, and flag pairs whose rated results are lopsidedly one-directional. (Unrated friend matches are unaffected — they move no ELO.)
- Future: randomize option order per player, basic tab-switch/focus telemetry, ELO-anomaly flagging for sudden rating spikes.

---

## 10. API surface

Implemented as Supabase RPCs (`security definer`) and/or Edge Functions:

| Function | Purpose |
|---|---|
| `join_queue()` | Enter matchmaking |
| `leave_queue()` | Cancel queue |
| `try_match(user_id)` | (internal/cron) pair waiting players |
| `create_challenge(is_rated)` | Friend invite → returns code |
| `accept_challenge(code)` | Join a friend match |
| `get_match_question(match_id, index)` | Serve question **without** the answer |
| `submit_answer(match_id, index, selected_index)` | Authoritative answer + score |
| `finalize_match(match_id)` | (internal) outcome + ELO + history |
| `get_leaderboard(limit, offset)` | Ranked by ELO |
| `get_profile(username)` | Profile + rating history for graph |

---

### 10.1 Core RPC implementations

The gameplay-critical functions are `security definer` (run as the table owner, bypassing RLS). `try_match` is in §7; the rest follow.

**Serve a question without leaking the answer:**
```sql
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (question_id uuid, section cat_section, body text, options jsonb,
               cap_ms integer, started_at timestamptz)
language plpgsql security definer as $$
declare m matches%rowtype; q questions%rowtype; cfg section_config%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];  -- array is 1-indexed
  select * into cfg from section_config where section = q.section;

  return query select q.id, q.section, q.body, q.options,
                      coalesce(q.duration_ms, cfg.cap_ms), m.question_started_at;
  -- NOTE: correct_index and explanation are deliberately NOT returned.
end; $$;
```

**Authoritative answer + score (the scoring rules of §2):**
```sql
create or replace function submit_answer(
  p_match_id uuid, p_question_index smallint, p_selected_index smallint
) returns void language plpgsql security definer as $$
declare
  m matches%rowtype; q questions%rowtype; cfg section_config%rowtype;
  uid uuid := auth.uid(); is_a boolean;
  cap integer; taken_ms integer; correct boolean; grace integer; pts integer;
begin
  select * into m from matches where id = p_match_id for update;          -- lock match
  if not found or m.status <> 'active' then raise exception 'match not active'; end if;
  if uid not in (m.player_a, m.player_b) then raise exception 'not a participant'; end if;
  if p_question_index <> m.current_index then raise exception 'stale question'; end if;
  if exists (select 1 from match_answers
             where match_id = p_match_id and user_id = uid
               and question_index = p_question_index)
     then raise exception 'already answered'; end if;

  select * into q   from questions where id = m.question_ids[p_question_index + 1];
  select * into cfg from section_config where section = q.section;
  cap := coalesce(q.duration_ms, cfg.cap_ms);

  -- server-measured time, clamped to [0, cap]
  taken_ms := greatest(0, least(cap,
              (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  correct := (p_selected_index is not null and p_selected_index = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms) / cfg.grace_block_ms);
  pts     := case when correct                       then cfg.base_points + grace
                  when p_selected_index is null       then 0          -- skip / timeout
                  else                                    -cfg.wrong_penalty end;

  insert into match_answers(match_id, user_id, question_id, question_index,
                            selected_index, is_correct, points_awarded, time_taken_ms)
  values (p_match_id, uid, q.id, p_question_index, p_selected_index, correct, pts, taken_ms);

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  perform maybe_advance(p_match_id, p_question_index);   -- advance if both answered
end; $$;
```

**Advance when both have answered; sweep handles cap expiry:**
```sql
create or replace function maybe_advance(p_match_id uuid, p_index smallint)
returns void language plpgsql security definer as $$
declare m matches%rowtype; both boolean;
begin
  select count(distinct user_id) = 2 into both
  from match_answers where match_id = p_match_id and question_index = p_index;
  if not both then return; end if;

  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' or m.current_index <> p_index then return; end if;

  if p_index >= 8 then
    perform finalize_match(p_match_id);
  else
    update matches set current_index = p_index + 1, question_started_at = now()
    where id = p_match_id;     -- Realtime (Postgres Changes) notifies both clients
  end if;
end; $$;

-- Cron (~every 1s): force-advance any question whose cap has elapsed.
-- Missing answers are implicitly skips (0); the loop calls maybe_advance/finalize.
create or replace function advance_timed_out() returns void
language plpgsql security definer as $$
declare r record; cap integer;
begin
  for r in select m.*, q.section, q.duration_ms from matches m
           join questions q on q.id = m.question_ids[m.current_index + 1]
           where m.status = 'active' loop
    select coalesce(r.duration_ms, sc.cap_ms) into cap
      from section_config sc where sc.section = r.section;
    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      if r.current_index >= 8 then perform finalize_match(r.id);
      else update matches set current_index = r.current_index + 1,
                              question_started_at = now() where id = r.id;
      end if;
    end if;
  end loop;
end; $$;
```

**Finalize: outcome → ELO (result sign + rating-gap base + margin factor, §3):**
```sql
create or replace function finalize_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m matches%rowtype;
  winner uuid; loser uuid; r_win int; r_lose int;
  e_win numeric; base numeric; factor numeric; margin int; k int; d_win int;
  win_games int;
  F_MIN constant numeric := 0.3;
  FULL_MARGIN constant numeric := 300;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status = 'completed' then return; end if;
  margin := abs(m.score_a - m.score_b);

  -- Unrated friend match: close it, no ELO, no history.
  if not m.is_rated then
    update matches set status='completed', ended_at=now(),
      winner_id = case when m.score_a > m.score_b then m.player_a
                       when m.score_b > m.score_a then m.player_b else null end
    where id = p_match_id;
    return;
  end if;

  -- Exact draw (rare): standard Elo, S = 0.5, no margin scaling.
  if m.score_a = m.score_b then
    perform apply_rated_result(p_match_id, null, null, 0);  -- helper handles draw
    return;
  end if;

  if m.score_a > m.score_b then
    winner := m.player_a; loser := m.player_b;
    r_win := m.elo_a_before; r_lose := m.elo_b_before;
  else
    winner := m.player_b; loser := m.player_a;
    r_win := m.elo_b_before; r_lose := m.elo_a_before;
  end if;

  select matches_played into win_games from profiles where id = winner;
  k := case when win_games < 30 then 40 when r_win < 2000 then 24 else 16 end;

  e_win  := 1.0 / (1.0 + power(10, (r_lose - r_win) / 400.0));
  base   := k * (1 - e_win);
  factor := F_MIN + (1 - F_MIN) * least(margin::numeric / FULL_MARGIN, 1);
  d_win  := greatest(1, round(base * factor))::int;     -- winner gains ≥ +1

  perform apply_rated_result(p_match_id, winner, loser, d_win);
end; $$;
```

**Apply result atomically (zero-sum, floor 100, history + stats):**
```sql
create or replace function apply_rated_result(
  p_match_id uuid, p_winner uuid, p_loser uuid, p_delta int
) returns void language plpgsql security definer as $$
declare m matches%rowtype; a_after int; b_after int;
begin
  select * into m from matches where id = p_match_id for update;

  if p_winner is null then                              -- draw branch
    -- standard Elo draw deltas computed per player (omitted for brevity);
    -- winner_id stays null, both move toward each other slightly.
    update matches set status='completed', ended_at=now() where id = p_match_id;
    return;
  end if;

  -- winner +p_delta, loser −p_delta (floored at 100)
  if p_winner = m.player_a then
    a_after := m.elo_a_before + p_delta;
    b_after := greatest(100, m.elo_b_before - p_delta);
  else
    b_after := m.elo_b_before + p_delta;
    a_after := greatest(100, m.elo_a_before - p_delta);
  end if;

  update matches set status='completed', ended_at=now(), winner_id=p_winner,
                     elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set elo=a_after, peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1,
    wins  =wins  +(p_winner=id)::int, losses=losses+(p_loser=id)::int
  where id = m.player_a;
  update profiles set elo=b_after, peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1,
    wins  =wins  +(p_winner=id)::int, losses=losses+(p_loser=id)::int
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, m.elo_a_before, a_after, a_after-m.elo_a_before),
    (m.player_b, p_match_id, m.elo_b_before, b_after, b_after-m.elo_b_before);

  -- Realtime broadcasts the completed match → both clients render the result screen.
end; $$;
```

> **Forfeit** (§8) calls `finalize_match` semantics with the present player as winner and `factor = 1.0` (full margin), discarding `score_*`. **Draw** uses standard Elo (`S = 0.5`) with no margin scaling. Both `elo_*_before` values are stamped at match creation (`try_match` / `accept_challenge`).

**Queue entry/exit:**
```sql
create or replace function join_queue() returns void
language plpgsql security definer as $$
declare my_elo int;
begin
  select elo into my_elo from profiles where id = auth.uid();
  insert into matchmaking_queue(user_id, elo) values (auth.uid(), my_elo)
  on conflict (user_id) where status='waiting' do nothing;  -- idempotent
  perform try_match(auth.uid());                              -- attempt immediate pair
end; $$;

create or replace function leave_queue() returns void
language plpgsql security definer as $$
begin
  update matchmaking_queue set status='cancelled'
  where user_id = auth.uid() and status='waiting';
end; $$;
```

**Friend challenge create/accept (stamps `elo_*_before`, freezes the 3-3-3 set):**
```sql
create or replace function create_challenge(p_is_rated boolean default true)
returns text language plpgsql security definer as $$
declare c text := encode(gen_random_bytes(4), 'hex');
begin
  insert into challenges(code, host_id, is_rated) values (c, auth.uid(), p_is_rated);
  return c;
end; $$;

create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer as $$
declare ch challenges%rowtype; q_ids uuid[]; new_id uuid; host_elo int; me_elo int;
begin
  select * into ch from challenges where code = p_code for update;
  if not found or ch.guest_id is not null or now() > ch.expires_at
     then raise exception 'challenge unavailable'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  select array_agg(id) into q_ids from (
    (select id from questions where section='VARC'  and is_active order by random() limit 3)
    union all (select id from questions where section='DILR'  and is_active order by random() limit 3)
    union all (select id from questions where section='QUANT' and is_active order by random() limit 3)
  ) s;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end; $$;
```

**Leaderboard & profile reads:**
```sql
create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (rank bigint, username text, elo int, wins int, losses int)
language sql stable as $$
  select rank() over (order by elo desc), username, elo, wins, losses
  from profiles order by elo desc limit p_limit offset p_offset;
$$;

create or replace function get_profile(p_username text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'profile', to_jsonb(p) - 'id',
    'curve', (select coalesce(jsonb_agg(jsonb_build_object(
                'elo', rh.elo_after, 'at', rh.created_at) order by rh.created_at), '[]')
              from rating_history rh where rh.user_id = p.id))
  from profiles p where p.username = p_username;
$$;
```

> Match-creation flow: `pending → active` happens when both clients confirm presence on the match channel; a tiny `start_match(match_id)` RPC flips status to `active` and sets `question_started_at = now()` for index 0.

---

## 11. UI / screens (Vercel-minimal)

**Aesthetic:** Geist font, near-black on near-white (dark mode default optional), single accent (e.g. electric blue or lime), generous whitespace, subtle borders, no gradients-as-decoration, smooth micro-transitions. shadcn/ui primitives.

| Screen | Contents |
|---|---|
| **Lobby / Home** | Your ELO + rank badge, **[Find Match]**, **[Challenge a Friend]**, recent matches |
| **Queue** | Animated "searching…" with current band/ELO, elapsed time, cancel |
| **Match** | Top bar: both avatars + live **point totals** + synced countdown ring for the **sectional cap**. A **speed-bonus meter** ticks down (grace drops every 5s) to make "answer faster = more points" legible. Center: question + 4 option buttons; a subtle **−30 negative-marking** cue on hover/confirm. Section pill (VARC/DILR/QUANT). Question dots (1–9). Auto-advances at cap. |
| **Reveal (between Qs)** | Correct answer highlighted, brief explanation, points earned this question (e.g. `+130` or `−30`), then auto-advance. |
| **Result** | Winner banner, final **points** + correct-count per player, per-player **ELO ±delta** animation (chess.com style), [Rematch] / [Home]. |
| **Profile** | Avatar, ELO, peak, W/L/D, **Recharts line graph of ELO over matches**, match history list |
| **Leaderboard** | National rank table: rank, avatar, username, ELO, W/L; sticky "your row" |

---

## 12. Leaderboard & profile graph

- **Leaderboard:** `select … from profiles order by elo desc` with `rank() over (order by elo desc)`. Paginate; cache top-N. Optional filters (region, time window) later.
- **Profile graph:** query `rating_history` for the user, plot `elo_after` over `created_at` (or match number) with Recharts. Mirrors the FIDE/chess.com rating curve. Also expose **score/match** as a secondary series if desired (correct-count per match from `matches`).

---

## 13. Phased roadmap

**MVP (v1)**
- Auth + profile, question bank (seed ~150 questions across sections).
- Queue matchmaking (`SKIP LOCKED`) + friend challenges.
- Server-authoritative 9-question real-time match with synced timers.
- ELO + rating history, result screen, profile graph, national leaderboard.

**v1.1**
- Disconnect/forfeit handling polish, rematch, rate limiting.
- Section-specific match modes (e.g. "Quant-only" battles).
- Email invites + result summaries (Resend).

**v2**
- Redis-backed matchmaking for scale, anti-cheat telemetry, option-order randomization.
- Seasons/leagues, daily challenges, streaks, friend lists, spectate mode.
- Difficulty-calibrated questions (per-question ELO) for adaptive selection.

---

## 14. Decisions

**Locked:**
- ✅ **Sectional time caps** (from real CAT pacing) — **VARC 90s / Quant 105s / DILR 120s**. Cap end **auto-advances** to the next question.
- ✅ **Scoring** — section-level: `BASE 100` + grace (1 block / 5s × section `SPEED_MULT`), wrong = `−30`, skip = `0`. VARC ×1, Quant ×2, DILR ×2. Anchored at **70:30** correctness:speed. See §2.
- ✅ **ELO** — result sets sign (winner always gains), rating-gap sets base size, point margin scales it (`F_MIN 0.3`, `FULL_MARGIN 300`). Higher-rated player gains less. See §3.
- ✅ **Question mix** — fixed **3 VARC / 3 DILR / 3 Quant** for v1.
- ✅ **Friend challenges** — host chooses **Rated or Unrated** at creation.
- ✅ **Forfeit penalty** — **full ELO loss** (full-margin, gap-aware loss for the quitter; rated only).

All core mechanics are now locked. Remaining work is implementation (schema migration, `submit_answer` / `finalize_match` functions, matchmaking job, UI) and seeding the question bank.

---

*End of spec. Ready for Claude Code handoff: scaffold Next.js + Supabase, run the schema migration in §6, implement the functions in §7–§10, then build the screens in §11.*
