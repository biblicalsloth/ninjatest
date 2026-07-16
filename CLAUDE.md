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
| Hosting | Vercel — **three projects off this one repo** (waitlist / staging / admin), see Deployments |
| DB + Auth | Supabase (Postgres + Auth + RLS), Google OAuth via `signInWithOAuth` |
| Realtime | Supabase Realtime (Broadcast + Presence + Postgres Changes) |
| Authoritative logic | Supabase `security definer` RPCs (Postgres functions; no Edge Functions) |
| Scheduled jobs | `pg_cron` — `rematch_waiting` + `advance_timed_out` every minute, `end_current_season` hourly |
| UI | Tailwind v4 + shadcn/ui (`components.json`, style `base-nova`), Lucide, sonner, `next-themes` (dark forced) |
| Charts | Recharts (`components/elo-graph.tsx`) |
| Email | Resend (`lib/email.ts`, `app/api/email/{challenge,result}/route.ts`) |
| Landing FX | `@antoineview/grainient` + `ogl` (`components/Grainient.jsx`) — landing page only. Mounted `dynamic(ssr:false)` in an `absolute inset-0` layer *behind* the scroll container, so it never appears in server HTML. **Every landing `<section>` must stay transparent** — an opaque `bg-[#120F17]` on one reads as a framed box against the gradient (the hero's did, removed in `320ffc1`). `components/Aurora.tsx` also imports `ogl` and is otherwise dead — deleting it means dropping the dep. |

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
- `/leaderboard` — top 100 + season banner; ISR `revalidate=60`. Public in the real app; auth-gated where `PRIVATE_LEADERBOARD=1` (staging only — see Deployments)
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
- `section_config` — all scoring dials; **never hardcode scoring constants in app code**. Caps VARC 90s / QUANT 105s / DILR 120s; `reading_ms` (VARC/DILR 60s, QUANT 0) extends the clock of the FIRST question of a passage group in a match (`20260715100000`); `speed_mult` is numeric, tuned for section parity (2.22 / 1.90 / 1.67 → max speed bonus 40 and max 140/question in every section); base 100, grace block 5000ms. `wrong_penalty` column is retired (kept, unread) — the penalty is derived in `submit_answer` since `20260715000000`.
- `rating_history` — append-only ELO timeline (null match_id = season reset row); powers the profile graph.
- `challenges` — invite codes (pgcrypto), 15-min expiry, `is_rated` + `section_mode` fixed at creation.
- `seasons` / `season_results` — monthly-ish soft resets; world-readable.
- `friendships` — ordered-pair PK (`user_a < user_b`), status pending/accepted; RLS enabled with **zero policies** (definer RPCs only).
- `match_events`, `rpc_rate_limit`, `ip_rate_limit` — RLS enabled, zero policies (server-only).
- `waitlist` — `email` unique + survey fields; anon INSERT-only with validation, no client read, duplicate email is a no-op success. Postgres is the sole store (Google Sheets webhook removed 2026-07-01 after silently 401ing). View in Supabase Studio or `/admin/waitlist`.

### Scoring (in `submit_answer`, final in `20260715100000`)
```
base    = coalesce(question.duration_ms, section cap_ms)
cap     = question_cap_ms(question_ids, index)         # base + reading_ms iff first question of its passage in the match
taken   = clamp(now() − question_started_at, 0, cap)   # measured server-side; client timing ignored
bonus   = round(speed_mult × floor(least(cap − taken, base) / grace_block_ms))   # reading window is bonus-free grace
correct → base_points + bonus
wrong   → −round((base_points + bonus) / (n_options − 1))   # rides the same speed curve
skipped → 0
```
**`question_cap_ms` is the single cap source** — `get_match_question`, `get_match_question_spectator`, `submit_answer`, `advance_timed_out`, `forfeit_match`, `bot_act`, `get_debrief_data` all call it (`20260715100000`); never reintroduce an inline `coalesce(duration_ms, cap_ms)` in a match-context function or timers desync. `finalize_match`'s FULL margin deliberately stays on the base cap (max bonus is base-derived). Guarded by stress-test section 12.
The wrong penalty is derived, not a config dial: it makes a random guess exactly EV-neutral at every t and any option count (with 4 options a flat −30 made instant blind guessing worth ~+9 EV/question — a snap-guess exploit), and converges to CAT's 1:3 ratio at the cap. Section parity: every section maxes at 140/question. Guarded by stress-test section 2/2a.

### Player ELO (`apply_rated_result`/`finalize_match`/`submit_answer` final in `20260715000000`; `apply_draw`/`forfeit_match`/`advance_timed_out` final in `20260713090000_audit_round2_fixes.sql`)
```
K        = 40 if games<30 else 24 if elo<2000 else 16
E_winner = 1 / (1 + 10^((R_loser − R_winner) / 400))
factor   = 0.3 + 0.7 × min(|score_margin| / FULL, 1)   # forfeit: 1.0
FULL     = 0.2 × Σ per question (base + maxbonus) × (1 + 1/(n_opts−1))
           # mirrors the derived wrong penalty; with parity + 4 options ≈ 336 in every mode
factor  *= 2.2 / (0.001×(R_winner − R_loser) + 2.2) if winner was rating favorite
           # favorite-shrink (FiveThirtyEight-style): margin×(1−E) overrates
           # favorites via autocorrelation; underdog wins untouched
Δ        = max(0, round(K × (1 − E_winner) × factor)) # no forced +1 (was a farm-+1-off-many-weak leak)
Δ_eff    = max(0, min(Δ, R_loser − 100))               # 100-ELO floor, strictly zero-sum
winner += Δ_eff; loser −= Δ_eff                        # beating a floored (100) opponent gains 0
```
Calibration report: `scripts/elo-calibration.sql` (read-only; buckets rated matches by rating gap, predicted-vs-actual + Brier — tune K and the 0.3/0.7 split from it once there are a few hundred rated matches).
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
See `DESIGN.md` — now the accurate shipped system. Essentials: dark-only, page bg `#120F17` (near-black violet, *not* teal), cards `#111111`, mint accent `#06d6a0` as the only CTA color, gold `#ffd166` for ratings, pink `#ef476f` for losses. Type pairing: Geist (body default via `--font-sans`) + Geist Pixel Square (`.font-pixel` display) + Geist Mono for explicit `font-mono` accents. Component code writes raw hex arbitrary values (`text-[#7ab5cc]`) rather than token classes — match that idiom in existing files. Tokens live in `app/globals.css:7-32`; section badge + league color vocabularies in `lib/utils.ts` / `lib/leagues.ts`.

## Deployments (three Vercel projects, one repo — check this before debugging any "it works on X but not Y")
The repo builds under **three separate Vercel projects**, each with its own env vars. Behaviour differs by *project*, not by branch or `VERCEL_ENV`, and nothing in the code names them — this has burned real debugging time.

| Project | Prod branch | Serves | Mode | Auto-deploys? |
|---|---|---|---|---|
| `ninjatest` | `main` | `ninjatest.app` → 308 → `www.ninjatest.app` | **waitlist** (`NEXT_PUBLIC_APP_MODE=waitlist` on Production) | **no — build skipped, see below** |
| `ninjatest-flbe` | `main` | `test.ninjatest.app` **and** `ninjatest-test.vercel.app` | **full app**, deployed as its own *production* | yes |
| admin console | — | `admin.<domain>`, behind Vercel Authentication | `ADMIN_ENABLED=1` | — |

**Both production projects build `main`.** Staging is not a branch — it is a second project off the same branch with different env vars. The `test` branch is vestigial: it only produces SSO-gated previews nobody looks at. Don't reach for branches to change what staging runs; reach for that project's env vars.

### Release flow (deliberately one-way)
A push to `main` deploys **staging only**. `ninjatest` has its Ignored Build Step set to `exit 0`, so its Git builds are skipped — production is frozen until promoted by hand. Verify what you shipped on `test.ninjatest.app`, then go live **once**:
1. Clear the Ignored Build Step on `ninjatest` (dashboard, or `PATCH /v9/projects/prj_ejXGHpLJk31Sysn7RxRuoIE0BBlq` with `commandForIgnoringBuildStep: null` — the CLI has no flag for it).
2. Remove `NEXT_PUBLIC_APP_MODE` from `ninjatest` Production — this is the waitlist→app flip; the landing stops being the front door and `/` redirects authed users to `/lobby`.
3. Redeploy `main`, confirm `www.ninjatest.app`.
4. Re-set the Ignored Build Step to `exit 0` to refreeze production.

Because both projects build the same branch, step 3 ships the exact commit staging validated.

Traps, all learned the hard way:
- **`test.ninjatest.app` is NOT a preview of `ninjatest`.** It is `ninjatest-flbe`'s *production*, so `VERCEL_ENV === "preview"` is false there. Gating staging behaviour on `VERCEL_ENV` is a silent no-op.
- **`ninjatest-flbe` answers on two public hostnames**, so a hostname check on `test.ninjatest.app` leaves `ninjatest-test.vercel.app` serving the same thing. Gate on a project-scoped env var instead.
- `ninjatest-flbe` has no `NEXT_PUBLIC_APP_MODE` — undefined `!== "waitlist"`, which is *why* it runs the full app.
- Per-commit `*.vercel.app` preview URLs are Vercel-SSO-gated; the two hostnames above are not.
- `vercel env pull` redacts every value to `""`. To find out what a deployment actually does, curl it.
- **`main` is not "production" in the usual sense** — it is the staging trunk. Pushing it is safe and expected; it does not reach `ninjatest.app`.
- Neither the project split nor the build guard is visible in this repo (no `vercel.json`). Everything above lives in Vercel project settings — this file is the only record.

## Environment
| Var | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | |
| `NEXT_PUBLIC_APP_MODE` | `ninjatest` Production only | `waitlist` = landing-only front door. Absent everywhere else → full app. |
| `NEXT_PUBLIC_SITE_URL`, `RESEND_API_KEY` | all | email links + Resend |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | `lib/ai/model.ts` | Ninja AI |
| `ADMIN_ENABLED` | admin deployment + `.env.local` | `=1` makes middleware serve **only** the console: `/` → `/admin`, every other path 404s. Set locally, so `/` will NOT render the landing on your dev server — run `ADMIN_ENABLED= npm run dev` to see it. Elsewhere `/admin*` 404s. |
| `PRIVATE_LEADERBOARD` | `ninjatest-flbe` only (Prod + Preview) | `=1` drops `/leaderboard` from `isPublicRoute` so the staging board isn't publicly browsable. **Never set it on `ninjatest`** — that would make the real leaderboard auth-only and forfeit its ISR caching. |
| `SUPABASE_SERVICE_ROLE_KEY` | local ingest scripts only | never in app code |

`.env.local.example` is stale (omits most of the above; lists unused `NEXT_PUBLIC_APP_URL`); `DEV_BYPASS`/`NEXT_PUBLIC_DEV_BYPASS` in `.env.local` are referenced nowhere.

## Known dead code / drift
- `components/Aurora.tsx`, `components/error-boundary.tsx`, `components/ui/dropdown-menu.tsx` — unreferenced.
- `lib/supabase/types.ts` lags migrations → `as any` casts scattered through clients.
