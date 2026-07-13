# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Ninjatest** — real-time, ELO-rated 1v1 CAT (Common Admission Test) prep battles. 9 questions (3 VARC + 3 DILR + 3 Quant, or 9 from one section in section-mode challenges), synchronized per-question timers, server-authoritative scoring. Original spec: `ninjatest-product-spec.md` (pre-build handoff — predates the waitlist pivot, spectate, seasons, admin console, and all hardening; historical context only). Design system: `DESIGN.md` (the actual shipped tokens/idioms, rewritten from live code — the old MongoDB analysis is gone).

**Status: MVP fully built and hardened.** All screens, ~45 RPCs across 45 migrations, spectate mode, seasons/leagues, win streaks, friend lists, daily tasks, admin question console, and 3+ rounds of security/perf hardening are shipped on `main`.

**Current front door is the waitlist landing page, not the battle app.** `NEXT_PUBLIC_APP_MODE=waitlist` (`.env.local`) makes `/` render `landing-client.tsx` (marketing + 6-step survey into the `waitlist` table). In waitlist mode the middleware (`lib/supabase/middleware.ts`) blocks every route except `/`, `/api/waitlist`, and `/auth/*` — signing in works (email/password, Google OAuth, password reset) but app routes bounce to `/` even for authed users. Flip the env var to restore the battle app (then `/` redirects authed users to `/lobby`; public routes become `/`, `/auth`, `/c/`, `/leaderboard`, `/profile`).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, RSC + route handlers, `proxy.ts` not `middleware.ts`), React 19 |
| Hosting | Vercel |
| DB + Auth | Supabase (Postgres + Auth + RLS), Google OAuth via `signInWithOAuth` |
| Realtime | Supabase Realtime (Broadcast + Presence + Postgres Changes) |
| Authoritative logic | Supabase `security definer` RPCs (Postgres functions; no Edge Functions) |
| Scheduled jobs | `pg_cron` — `rematch_waiting` + `advance_timed_out` every minute, `end_current_season` hourly |
| UI | Tailwind v4 + shadcn/ui (`components.json`, style `base-nova`), Lucide, sonner, `next-themes` (dark forced) |
| Charts | Recharts (`components/elo-graph.tsx`) |
| Email | Resend (`lib/email.ts`, `app/api/email/{challenge,result}/route.ts`) |
| Landing FX | `@antoineview/grainient` + `ogl` (`components/Grainient.jsx`) — landing page only |

## Commands

```bash
npm run dev          # dev server
npm run build        # build
npm run lint         # lint
npx tsc --noEmit     # type check

# invariant tests (rollback harness — inserts auth.users; run on a branch/local DB, never prod)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/elo-stress-test.sql

# Monte-Carlo backing the question-ELO constants (deterministic seed)
node scripts/simulate-question-elo.mjs
```

## Routes (actual)

- `/` — waitlist landing (waitlist mode) or authed-redirect to `/lobby` (live mode)
- `/auth/{login,signup,forgot-password,reset-password}`, `/auth/callback` (route handler; open-redirect-guarded `next` param)
- `/lobby` → `/queue` → `/match/[matchId]` → `/result/[matchId]` — the battle loop
- `/spectate` (live-match browser) → `/spectate/[matchId]` (read-only viewer)
- `/profile/[username]` — tabs: overview / history / stats / friends; ISR `revalidate=60`
- `/leaderboard` — top 100 + season banner; ISR `revalidate=60`
- `/settings` — display name, password, avatar upload (Storage bucket `avatars`, `${userId}/avatar.*`)
- `/c/[code]` — friend-challenge accept (15-min expiry)
- `/admin` — question-bank console (JSON/CSV upload, passage groups, active toggles, per-section STARVED flags); `/admin/waitlist` — signups table. Both gated on `profiles.is_admin`.
- `POST /api/waitlist`, `POST /api/email/challenge`, `POST /api/email/result` — the only route handlers; `proxy.ts` matcher excludes `/api`, each handler does its own auth + rate limiting.

## Architecture

### Server-authoritative invariant
**Never trust the client for scoring, timing, ELO, or matchmaking.** All game-critical logic runs in Supabase `security definer` RPCs (bypass RLS, run as table owner). Clients only call RPCs and render. Clients widely cast `supabase as any` because `lib/supabase/types.ts` lags the migrations (e.g. `is_admin`) — regenerate types rather than adding more casts when touching this.

### RPC surface (final definition = latest migration that recreates it — always check migration order)

- **Queue/matchmaking**: `join_queue` (rate-limited 10/10s; rejects callers already in a live match; prunes the caller's finished queue rows), `leave_queue` (returns boolean — false = the leave-vs-match race was lost, client must route into the match), `queue_heartbeat` (client pings every 20s; returns whether a waiting row still exists), `try_match` → `try_match_internal` (atomic `FOR UPDATE SKIP LOCKED` pairing; ELO band `min(1000, 100 + wait_s×20)`, wider of the two players' bands; rated-pair guard <3/day via `rated_pair_count_today`, which ignores never-rated abandons), `rematch_waiting` (cron sweep; cancels waiting rows with heartbeat >90s stale, prunes finished rows >1 day), `pick_section_question_ids(section, target_elo)` (adaptive picker, final in `20260713050000`), `get_server_time` (client clock sync)
- **Challenges**: `create_challenge(is_rated, section_mode)` (section_mode null = mixed 3-3-3, else 9 one-section), `accept_challenge`
- **Match lifecycle**: `start_match`, `get_match_question` (strips `correct_index`/`explanation`, serves per-player shuffled options), `submit_answer` (authoritative scoring, un-shuffles to canonical, atomic question-ELO nudge, `fast_answer` telemetry, rate-limited 20/5s), `maybe_advance`, `advance_timed_out` (cron: abandons no-show pending >2min, inserts null skip-rows with `time_taken_ms = NULL` — the cron marker; a client submission always records a time — advances/finalizes), `get_answer_reveal` (never reveals unreached questions on abandoned matches), `finalize_match` (margin factor, normalized to the match's own max margin), `apply_rated_result` (all rating math + streaks, under ordered row locks), `apply_draw` (zero-sum, K = least of the pair), `forfeit_match` (requires server-verified absence: opponent missed the full question deadline +5s with no row, OR has a cron-null skip row on the previous question; rated no-skill forfeits transfer nothing; factor 1.0). Final defs for the lifecycle RPCs: `20260713090000_audit_round2_fixes.sql`.
- **Spectate**: `get_spectator_match`, `get_match_question_spectator`, `get_active_matches`, `broadcast_spectator_update` (internal; `realtime.send` of safe fields only)
- **Friends**: `search_profiles`, `send_friend_request`, `respond_friend_request`, `remove_friend`, `get_friends`
- **Seasons**: `end_current_season` (hourly cron; snapshot to `season_results`, soft reset `elo = 1000 + (elo−1000)/2`, reset rows into `rating_history`), `get_current_season`
- **Reads** (intentionally anon-callable for logged-out views): `get_leaderboard`, `get_profile`, `get_profile_matches`, `get_recent_matches`, `get_section_stats`, `get_profile_deep_stats`, `get_daily_progress` (auth-only; computes matches/wins today — dailies are derived, no new tables)
- **Rate limiting**: `check_rate_limit` (per-user, RAISES on exceed), `check_ip_rate_limit` (per-IP, returns retry-after seconds, 0 = ok; granted to anon for unauth routes)
- **Telemetry**: `log_match_event` (client whitelist: `tab_hidden`/`window_blur`; 40/10s) → `match_events`; server adds `fast_answer` (correct <2s)
- **Admin** (first statement is an `is_admin` guard): `admin_upsert_questions`, `admin_list_questions`, `admin_set_question_active`, `admin_set_passage_active`, `get_waitlist_admin`
- **Trigger**: `handle_new_user` — OAuth-safe (slugified username, collision suffixes, maps Google name/picture; never aborts the auth insert). It does **not** seed `is_admin` — the owner was seeded by a one-time block; grant admin via SQL, not signup logic.

Anon/PUBLIC execute is revoked on all auth-required RPCs (`20260627000200`); internal helpers are revoked from all client roles. Read RPCs stay anon-accessible by design.

### Realtime channels
- `queue:${userId}` — postgres_changes on `matchmaking_queue`; `status='matched'` routes to the match.
- `match:${matchId}` — players: postgres_changes on `matches` (drives advance → 3s reveal → next question; completed → result) + broadcast `opponent_answered` (liveness only — **never** scores/correctness) + presence (both present → idempotent `start_match`; opponent absent → 30s client timer, then `forfeit_match`; server enforces the 20s grace). Spectators: broadcast-only `spectator_update` (no presence — spectators must not affect forfeit).
- `global:online` — presence, `lib/hooks/use-online-count.ts`, keyed by userId (dedupes tabs). Deliberately **not** subscribed on the landing page (one WS per anonymous visitor = billing risk).

Broadcast = liveness signals. Postgres Changes = authoritative state. DB is source of truth; clients `rehydrate()` from it on reconnect/`CHANNEL_ERROR`/window-online.

### Key tables
- `profiles` — ELO, peak, W/L/D, `current_streak`/`best_streak`, `is_admin`. Server-owned columns (elo, peak_elo, stats, is_admin) frozen from client UPDATE by RLS WITH CHECK.
- `matches` — status, frozen `question_ids[9]`, `current_index`, `question_started_at`, running scores, `elo_*_before/after`. `elo_*_before` is **re-synced at finalization** to the true locked base (ratings are relative to finalization, not match creation).
- `match_answers` — one row per player per question (unique `(match_id,user_id,question_index)`); `selected_index` stores the **canonical** index post-un-shuffle; null = skip.
- `questions` — no client read; `elo` (seeded `1000 + difficulty×100`), `times_seen`, optional `duration_ms` (overrides section cap), `passage_id` → `passages` (VARC/DILR groups).
- `matchmaking_queue` — `FOR UPDATE SKIP LOCKED` pairing; partial unique on waiting rows.
- `section_config` — all scoring dials; **never hardcode scoring constants in app code**. VARC 90s cap ×1, QUANT 105s ×2, DILR 120s ×2; base 100, penalty 30, grace block 5000ms.
- `rating_history` — append-only ELO timeline (null match_id = season reset row); powers the profile graph.
- `challenges` — invite codes (pgcrypto), 15-min expiry, `is_rated` + `section_mode` fixed at creation.
- `seasons` / `season_results` — monthly-ish soft resets; world-readable.
- `friendships` — ordered-pair PK (`user_a < user_b`), status pending/accepted; RLS enabled with **zero policies** (definer RPCs only).
- `match_events`, `rpc_rate_limit`, `ip_rate_limit` — RLS enabled, zero policies (server-only).
- `waitlist` — `email` unique + survey fields; anon INSERT-only with validation, no client read, duplicate email is a no-op success. Postgres is the sole store (Google Sheets webhook removed 2026-07-01 after silently 401ing). View in Supabase Studio or `/admin/waitlist`.

### Scoring (in `submit_answer`)
```
cap     = coalesce(question.duration_ms, section cap_ms)
taken   = clamp(now() − question_started_at, 0, cap)   # measured server-side; client timing ignored
correct → base_points + speed_mult × floor((cap − taken) / grace_block_ms)
wrong   → −wrong_penalty
skipped → 0
```

### Player ELO (`apply_rated_result` final in `20260713060000`; `finalize_match`/`apply_draw`/`forfeit_match`/`submit_answer`/`advance_timed_out` final in `20260713090000_audit_round2_fixes.sql`)
```
K        = 40 if games<30 else 24 if elo<2000 else 16
E_winner = 1 / (1 + 10^((R_loser − R_winner) / 400))
factor   = 0.3 + 0.7 × min(|score_margin| / FULL, 1)   # forfeit: 1.0
FULL     = 0.2 × Σ per question (base + penalty + speed_mult×⌊cap/grace⌋)
           # the match's own max margin: ≈300 mixed, 266 VARC-mode, 320 DILR-mode
           # (a fixed 300 overweighted ×2-speed_mult sections by ~26%)
Δ        = max(1, round(K × (1 − E_winner) × factor))
Δ_eff    = max(0, min(Δ, R_loser − 100))               # 100-ELO floor, strictly zero-sum
winner += Δ_eff; loser −= Δ_eff                        # beating a floored (100) opponent gains 0
```
R values are each player's **current** rating read under ordered row locks at finalization (not the match-creation snapshot) — overlapping rated matches chain correctly. Callers pass only the margin factor; all rating math lives in `apply_rated_result`. Draws: one shared delta at `K = least(K_a, K_b)` — strictly zero-sum, clamped to the 100 floor (per-player Ks used to mint ~+11/draw on K-mismatched pairs), reset both streaks. Wins +1 streak / update best; losses/draws zero it; unrated matches touch nothing.

### Question ELO (adaptive difficulty)
Nudged on every real answer in a **rated** match inside `submit_answer` (unrated matches never nudge — uncapped unrated challenges were a collusion channel into the bank) — one atomic UPDATE, clamp [400, 2800], K=32 while `times_seen < 20` else 16, result `0.35 × (taken_ms/cap)` for correct / `1.0` for wrong; any implausibly-fast (<2s) answer is excluded, correct or wrong (`fast_answer` telemetry stays correct-only). Selection biases toward the players' average ELO with `random()×300` jitter; VARC/DILR prefer one active passage group (≥3 active sub-questions, nearest mean-ELO) with standalone fallback; QUANT picks 3 standalone. Constants backed by `scripts/simulate-question-elo.mjs`; invariants tested by `scripts/elo-stress-test.sql`.

### Option-shuffle invariant (critical)
`option_perm(match_id, user_id, q_index, n)` — IMMUTABLE md5-based deterministic permutation. Three functions must share it: `get_match_question` (serves shuffled), `submit_answer` (maps display → canonical), `get_answer_reveal` (maps canonical correct → display). **Never change one without the other two.** Migration `20260713030000` recreated the readers from a pre-shuffle base and silently desynced scoring (fixed `20260713040000`); section 2 of `elo-stress-test.sql` guards this.

### Time synchronization
Server writes `question_started_at` on each advance; `time_taken_ms` is computed server-side at `submit_answer`. Client computes a real clock offset at match start (`get_server_time` at the request midpoint — corrects absolute skew, not just RTT), renders the deadline against it, and auto-submits null at 0. On opponent presence loss the client retries `forfeit_match` every 10s until the server's absence proof is satisfied or presence returns.

### Leagues
Pure computed ELO tiers, no table (`lib/leagues.ts`): Diamond ≥2100, Platinum ≥1800, Gold ≥1500, Silver ≥1200, Bronze. ELO is already fetched everywhere a badge renders.

### Rate limiting (two layers, both durable)
- RPC-level per-user (`rpc_rate_limit` + `check_rate_limit`, RAISES): submit_answer 20/5s, join_queue 10/10s, log_match_event 40/10s.
- IP-level (`ip_rate_limit` + `check_ip_rate_limit`, returns retry-after): `lib/rate-limit.ts::rateLimitDb` — **fail-open** on RPC error by design. Waitlist 5/60s/IP; email routes have per-user + per-IP limits. The old in-memory limiter is gone.

### Email routes (auth checks matter)
`/api/email/challenge` verifies the caller **owns** the challenge and it isn't expired; `is_rated` read from DB, never the client. `/api/email/result` verifies the caller is a match participant and sends only to the caller's auth email. Don't relax these — the open-relay variant was a real finding.

### Caching pattern
Public pages (leaderboard, profile) use `createPublicClient()` (cookieless, `persistSession:false`) + `revalidate=60` ISR; "(you)" highlighting is resolved client-side to keep the page cacheable. Auth-dependent pages are `force-dynamic`.

## RLS rules
- `questions` / `passages`: `using (false)` — served only via definer RPCs.
- `profiles`: world-readable; self-update with server-owned columns frozen via WITH CHECK.
- `matches` / `match_answers`: participants only. `rating_history`: own rows. `seasons`/`season_results`/`section_config`: public read.
- `matchmaking_queue` / `challenges`: own rows (challenges also readable when open+unexpired for accept flow).
- `friendships`, `match_events`, `rpc_rate_limit`, `ip_rate_limit`: RLS on, zero policies — definer-only.
- `waitlist`: validated anon INSERT only (INSERT-not-UPDATE means resubmits can't overwrite rows).
- Storage `avatars`: public bucket, writes scoped to `foldername[1] = auth.uid()`.
- All policies wrap `auth.uid()` as `(select auth.uid())` (initplan fix, `20260627000300`).

## Migration discipline (learned the hard way)
1. **`CREATE OR REPLACE` from a stale copy is the #1 regression vector.** It has bitten three times: `20260702000600` reverted `advance_timed_out` fixes (restored `000700`), `20260713030000` reverted the option shuffle (restored `040000`), and `20260713055000_oauth` silently dropped the `is_admin` seed from `handle_new_user`. Always start from the *latest* definition of a function, and re-check any invariant partner functions.
2. New `SECURITY DEFINER` functions: pin `set search_path = pg_catalog, public` **inline** (the `20260627000000` blanket pin is dropped by `create or replace`; add `extensions` if you need pgcrypto — the blanket pin once broke `create_challenge`), revoke from public/anon and grant explicitly, wrap `auth.uid()` in policies.
3. **MCP `apply_migration` gotcha**: applying DDL via the Supabase MCP does not insert into `supabase_migrations.schema_migrations` — the tracking table drifts from the files. Keep repo migrations as the source of truth and reconcile tracking when using MCP.
4. `002_rpc_functions.sql` is the original surface; nearly everything in it has been superseded. Grep all migrations for a function name and take the last definition.

## Security hardening history (context for new code)
2026-06-27: search_path pinning, grant hardening + storage policy cleanup, anon RPC revocation, RLS initplan + 9 FK indexes. 2026-07-13: option shuffle, `match_events` anti-cheat telemetry, durable IP rate limiting, admin unification on `profiles.is_admin`, OAuth-safe signup trigger, current-ELO zero-sum rating. `next.config.ts` ships a strict CSP (Supabase origin + wss only), HSTS preload, frame-deny, and a locked Permissions-Policy. Follow these patterns; the Supabase linter flags drift.

## UI
See `DESIGN.md` — now the accurate shipped system. Essentials: dark-only, page bg `#120F17` (near-black violet, *not* teal), cards `#111111`, mint accent `#06d6a0` as the only CTA color, gold `#ffd166` for ratings, pink `#ef476f` for losses, Geist Mono everywhere. Component code writes raw hex arbitrary values (`text-[#7ab5cc]`) rather than token classes — match that idiom in existing files. Tokens live in `app/globals.css:7-32`; section badge + league color vocabularies in `lib/utils.ts` / `lib/leagues.ts`.

## Environment
Used in code: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_MODE`, `RESEND_API_KEY`, `NEXT_PUBLIC_SITE_URL`. Note `.env.local.example` is stale (lists unused `SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_APP_URL`, omits the last three); `DEV_BYPASS`/`NEXT_PUBLIC_DEV_BYPASS` in `.env.local` are referenced nowhere.

## Known dead code / drift
- `components/Aurora.tsx`, `components/error-boundary.tsx`, `components/ui/dropdown-menu.tsx` — unreferenced.
- `app/match/[matchId]/{error,loading}.tsx` still use the pre-pivot teal palette (`#001e2b`/`#00ed64`).
- `lib/supabase/types.ts` lags migrations → `as any` casts scattered through clients.
