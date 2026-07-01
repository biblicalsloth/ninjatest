# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Ninjatest** — real-time, ELO-rated 1v1 CAT (Common Admission Test) prep battles. 9 questions (3 VARC + 3 DILR + 3 Quant), synchronized sectional timers, server-authoritative scoring. Full spec: `ninjatest-product-spec.md` (original pre-build handoff doc — predates the waitlist pivot and later hardening, treat as historical context, not current-state truth). Visual design system: `DESIGN.md` (MongoDB-derived tokens — deep teal `#001e2b` bg, `#00ed64` brand-green accent).

**Status: MVP fully built**, not a spec-only project. All core screens, ~20 RPCs, and 3 rounds of security/perf hardening are shipped on `main`.

**Current front door is the waitlist landing page, not the battle app.** `NEXT_PUBLIC_APP_MODE=waitlist` (`.env.local`) makes `/` (`app/page.tsx`) render `landing-client.tsx` (marketing + email capture into the `waitlist` table) instead of routing into the game. Logged-in users still redirect to `/lobby`; the full match flow is built and reachable, just not the default entry point in this mode. Flip the env var to restore the battle app as the front door.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, RSC + route handlers), React 19 |
| Hosting | Vercel |
| DB + Auth | Supabase (Postgres + Auth + RLS) |
| Realtime | Supabase Realtime (Broadcast + Presence + Postgres Changes) |
| Authoritative logic | Supabase `security definer` RPCs (Postgres functions, not Edge Functions) |
| UI | Tailwind v4 + shadcn/ui (`components.json`, style `base-nova`), Lucide icons, `next-themes` |
| Charts | Recharts (ELO history graph, `components/elo-graph.tsx`) |
| Email | Resend (`lib/email.ts`, `app/api/email/{challenge,result}/route.ts`) |
| Landing FX | `@antoineview/grainient`, `ogl`, `@base-ui/react` (`components/Aurora.tsx`, `Grainient.jsx`) — landing page only |

## Commands

```bash
# dev server
npm run dev

# build
npm run build

# lint
npm run lint

# type check
npx tsc --noEmit
```

## Screens / routes (actual)

- `/` — waitlist landing (`app/page.tsx` + `landing-client.tsx`) when `NEXT_PUBLIC_APP_MODE=waitlist`, else redirects authed users to `/lobby`
- `/auth/{login,signup,forgot-password,reset-password}`, `/auth/callback` — Supabase Auth flows
- `/lobby` → `/queue` → `/match/[matchId]` → `/result/[matchId]` — the battle loop
- `/profile/[username]` — stats + `elo-graph.tsx` history
- `/leaderboard`
- `/settings`
- `/c/[code]` — friend challenge accept page (15-min expiry codes)

## Architecture

### Server-authoritative invariant
**Never trust the client for scoring, timing, or ELO.** All game-critical logic runs in Supabase `security definer` RPCs (which bypass RLS and run as the table owner). Clients only render.

Full RPC surface (all in `supabase/migrations/002_rpc_functions.sql` unless noted, later migrations patch bugs — check migration order for the current definition):
- **Queue/matchmaking**: `join_queue`, `leave_queue`, `try_match` / `try_match_internal` (atomic `FOR UPDATE SKIP LOCKED` pairing)
- **Challenges**: `create_challenge`, `accept_challenge`, `rematch_waiting`
- **Match lifecycle**: `start_match`, `get_match_question` (strips `correct_index`/`explanation`), `submit_answer` (server-authoritative scoring, client timing ignored), `maybe_advance`, `advance_timed_out`, `get_answer_reveal` (post-question reveal — powers the Reveal screen), `finalize_match`, `apply_draw`, `apply_rated_result` (ELO), `forfeit_match`
- **Reads**: `get_leaderboard`, `get_profile`, `get_profile_matches`, `get_recent_matches`, `get_section_stats`, `rated_pair_count_today`
- **Auth trigger**: `handle_new_user`

Anon/PUBLIC execute is revoked on all auth-required RPCs (`20260627000200_restrict_anon_rpc.sql`) — only `authenticated`/`service_role` can call them. Read RPCs for logged-out leaderboard/profile views stay anon-accessible by design.

### Realtime split: broadcast vs. DB
- **Broadcast** = liveness signals (`opponent_answered: true`, question advance notifications). Never contains scores, correctness, or opponent's answer.
- **Postgres Changes** = authoritative state (match status, current question, final result). The DB is the source of truth; clients rehydrate from it on reconnect.

### Key database tables
- `profiles` — user ELO, W/L/D, stats. ELO/stats columns are write-protected from clients (server functions only).
- `matches` — match state, frozen `question_ids[]` array, running `score_a/b`, `current_index`, `question_started_at`.
- `match_answers` — one row per player per question; unique constraint enforces single-answer-per-Q.
- `matchmaking_queue` — `SELECT … FOR UPDATE SKIP LOCKED` atomic pairing via `try_match()`.
- `section_config` — per-section scoring dials (`cap_ms`, `base_points`, `speed_mult`, `wrong_penalty`). All scoring constants live here; never hardcode in application code.
- `rating_history` — append-only ELO timeline; powers the Recharts profile graph.
- `challenges` — friend invite codes (15-min expiry), `is_rated` flag set at creation.
- `waitlist` — `email` (unique) + `created_at` + survey fields `name`/`phone`/`year`/`percentile`/`section` (added `20260701000000_waitlist_survey_columns.sql`). Postgres is the sole store for `/api/waitlist` (plain `insert`, duplicate email is a no-op success — RLS grants anon INSERT only, not UPDATE, so a resubmission can't overwrite someone else's row). No external mirror (the Google Sheets webhook was removed 2026-07-01 — it had been silently failing with 401s since 2026-06-25). View signups in Supabase Studio's table editor (service role bypasses RLS there); there's no in-app admin UI.

### Scoring formula
```
correct → BASE + SPEED_MULT[section] × floor((cap_ms − time_taken_ms) / 5000)
wrong   → −PENALTY
skipped → 0
```
Section multipliers: VARC ×1, Quant ×2, DILR ×2. All constants from `section_config`.

### ELO formula
```
E_winner = 1 / (1 + 10^((R_loser − R_winner) / 400))
base     = K × (1 − E_winner)
factor   = 0.3 + 0.7 × min(|score_margin| / 300, 1)
Δ_winner = max(1, round(base × factor))
Δ_loser  = −Δ_winner   # zero-sum
```
K schedule: <30 matches → 40, ELO <2000 → 24, ELO ≥2000 → 16.

### Time synchronization
Server writes `question_started_at` on each advance. `time_taken_ms` = `now() − question_started_at` measured on the server when `submit_answer` arrives. Client renders `deadline = server_start_ts + cap_ms` using a one-time clock-offset sync at match start.

### Forfeit
Disconnect > 20s grace → `finalize_match` with present player as winner, `factor = 1.0` (full margin). Applies to rated matches only.

### App-layer rate limiting
`lib/rate-limit.ts` — in-memory sliding-window bucket keyed by client IP, applied to `app/api/waitlist/route.ts` (5 req/min/IP) and the email routes. **Explicitly best-effort**: state is per serverless instance and resets on cold start (see code comment) — first line of defense against trivial floods, not a hard guarantee. Swap for Upstash Redis / Vercel KV before this matters for production-grade abuse resistance.

## RLS rules
- `questions` table: **no client read** (`using (false)`). Served only via `get_match_question()`.
- `profiles`: world-readable; self-update allowed but `elo`/`peak_elo`/stats columns only writable by server functions.
- `matches` / `match_answers`: visible only to the two participants.
- `matchmaking_queue` / `challenges`: users manage only their own rows.
- `waitlist`: insert-only (validated), no client read.
- All RLS policies wrap `auth.uid()` as `(select auth.uid())` (initplan fix, `20260627000300_perf_rls_initplan_and_fk_indexes.sql`) to avoid per-row re-evaluation at scale.

## Security hardening applied (2026-06-27, 4 migrations)
1. `pin_function_search_path` — pins `search_path = pg_catalog, public` on every `SECURITY DEFINER` function (closes search_path-hijack vector).
2. `harden_grants_storage_waitlist` — revokes client EXECUTE on internal-only functions (`handle_new_user`, `rls_auto_enable`, `try_match`), drops redundant public-read storage policies, adds real validation to `waitlist` insert policy.
3. `restrict_anon_rpc` — revokes anon/PUBLIC execute on all auth-required RPCs, re-grants to `authenticated`/`service_role` only.
4. `perf_rls_initplan_and_fk_indexes` — `auth.uid()` initplan fix on all RLS policies + 9 FK covering indexes.

When adding new `security definer` functions or RLS policies, follow these same patterns (pin search_path, explicit grants, wrapped `auth.uid()`) rather than the defaults — the linter will flag drift.

## UI aesthetic
Not generic Vercel minimal, and not a literal copy of `DESIGN.md`'s MongoDB tokens either — `DESIGN.md` was inspiration/analysis, actual shipped palette diverged. Real tokens are in `app/globals.css:7-32` (`@theme inline`):

- Dark mode default. Surfaces near-black — `--color-teal-surface: #111111`, `--color-teal-elevated: #1c1c1c` — on a teal-deep base `#073b4c`.
- Primary accent: teal-green `--color-brand-primary: #06d6a0` (not MongoDB's `#00ed64`).
- Secondary accents: gold `#ffd166`, pink `#ef476f`, ocean blue `#118ab2` — used sparingly (status/chart colors), not as competing CTAs.
- Text: white ink `#ffffff`, secondary `#c5e8f0`, muted `#7ab5cc`, disabled `#4a8fa8`.
- Font: Geist **Mono** for both `--font-sans` and `--font-mono` (not Geist Sans).
- Light mode exists as a fallback (`:root` block) but is not the default experience.
- shadcn/ui primitives throughout, mapped onto these tokens via the `--color-*` shadcn variables.

Treat `app/globals.css` as the source of truth for tokens; `DESIGN.md` is reference/mood-board only, don't assume its literal hex values are what's live.

## Screens
Lobby → Queue → Match → Reveal (between Qs) → Result → Profile / Leaderboard, plus Settings, Auth, and Challenge-accept (`/c/[code]`). See §11 of `ninjatest-product-spec.md` for the original screen-by-screen breakdown (pre-dates waitlist mode and a few UI additions).
