# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Ninjatest** — real-time, ELO-rated 1v1 CAT (Common Admission Test) prep battles. 9 questions (3 VARC + 3 DILR + 3 Quant), synchronized sectional timers, server-authoritative scoring. Full spec: `ninjatest-product-spec.md`.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router, RSC + route handlers) |
| Hosting | Vercel |
| DB + Auth | Supabase (Postgres + Auth + RLS) |
| Realtime | Supabase Realtime (Broadcast + Presence + Postgres Changes) |
| Authoritative logic | Supabase Edge Functions / `security definer` RPCs |
| UI | Tailwind + shadcn/ui, Geist font, Lucide icons |
| Charts | Recharts (ELO history graph) |

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

## Architecture

### Server-authoritative invariant
**Never trust the client for scoring, timing, or ELO.** All game-critical logic runs in Supabase `security definer` RPCs (which bypass RLS and run as the table owner). Clients only render.

- `submit_answer` — validates, scores, and records answers server-side; client-reported timing is ignored
- `finalize_match` → `apply_rated_result` — computes ELO atomically in one transaction
- `get_match_question` — strips `correct_index` and `explanation` from the payload; correct answer revealed only after question closes

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

## RLS rules
- `questions` table: **no client read** (`using (false)`). Served only via `get_match_question()`.
- `profiles`: world-readable; self-update allowed but `elo`/`peak_elo`/stats columns only writable by server functions.
- `matches` / `match_answers`: visible only to the two participants.
- `matchmaking_queue` / `challenges`: users manage only their own rows.

## UI aesthetic
Vercel/Geist minimal: near-black on near-white, one accent color (electric blue or lime), generous whitespace, no decorative gradients, subtle borders. Dark mode default optional. shadcn/ui primitives throughout.

## Screens
Lobby → Queue → Match → Reveal (between Qs) → Result → Profile / Leaderboard. See §11 of the spec for full screen-by-screen breakdown.
