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

# Ninja invariant tests (rollback harness — same rules as elo-stress-test)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/ninja-guard-test.sql
node scripts/prompt-self-test.mts   # buildQuestionPrompt MCQ/TITA branches; no network, no env

# Live GLM5.2 end-to-end probe — SPENDS (~$0.004/question). Reproduces /api/ninja/ask's
# model path (live ai_config + real TITA row + buildQuestionPrompt) and grades the answer
# against answer_value. Skips auth/guards/save — ninja-guard-test.sql covers those.
node scripts/ninja-live-probe.mts --dry-run   # print prompts, call nothing
node scripts/ninja-live-probe.mts

# Question-bank embeddings — idempotent, only picks up `embedding is null`.
# Re-run after any /admin body edit; the staleness trigger nulls those rows for you.
node scripts/backfill-embeddings.mjs --self-test   # no network, no env
node scripts/backfill-embeddings.mjs --dry-run --limit 5
node scripts/backfill-embeddings.mjs
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
- `POST /api/waitlist`, `POST /api/email/challenge`, `POST /api/email/result` — `proxy.ts` matcher excludes `/api`, each handler does its own auth + rate limiting.
- `POST /api/ninja/*` — the AI layer (10 handlers). Same rules: no `proxy.ts` coverage, so **every one does its own auth, admin gate, and rate limiting inline**. See Ninja AI below.
- `/ninja/{chat,solve}` — user-facing AI pages (coach chat; PDF solver).

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
- **Admin** (first statement is an `is_admin` guard): `admin_upsert_questions`, `admin_list_questions`, `admin_set_question_active`, `admin_set_passage_active`, `get_waitlist_admin`, `admin_set_ai_config`, `admin_suspect_matches`, `admin_update_question_options`
- **Ninja AI** (final defs: `20260714150000` seed → `20260716201821_ninja_tita_aware` for the ask path and `get_recent_mistakes` → `20260716190000_openrouter_only` for config): `get_ai_config`, `get_question_for_ninja` (participant-only, never an unreached question, **3-attempt ceiling per (match, question, user) — checked pre-spend, it is the cost guard**; returns `qtype`/`answer_value`/`my_answer_text` so TITA isn't prompted with a blank key), `save_ninja_response`/`get_ninja_responses`, `get_debrief_data`/`save_ninja_debrief`/`get_ninja_debrief` (first-write-wins = never re-bill), `get_ninja_daily_focus`/`save_ninja_daily_focus` (1/day), `get_recent_mistakes`, `get_recent_coach_turns`/`get_coach_conversation`/`save_ninja_coach_turn`, `search_questions(p_embedding, p_section, p_limit, p_exclude)` (pgvector cosine; returns **ids + similarity only, never bodies**; `service_role` only and **no consumer wired yet** — takes a server-supplied vector, since an arbitrary caller-supplied one would be a bank-scraping oracle. Read Question embeddings below before granting it to anything)
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
- `questions` — no client read; `elo` (seeded `1000 + difficulty×100`), `times_seen`, optional `duration_ms` (overrides section cap), `passage_id` → `passages` (VARC/DILR groups), `embedding` (pgvector, see below).
- `matchmaking_queue` — `FOR UPDATE SKIP LOCKED` pairing; partial unique on waiting rows.
- `section_config` — all scoring dials; **never hardcode scoring constants in app code**. Caps VARC 90s / QUANT 105s / DILR 120s; `reading_ms` (VARC/DILR 60s, QUANT 0) extends the clock of the FIRST question of a passage group in a match (`20260715100000`); `speed_mult` is numeric, tuned for section parity (2.22 / 1.90 / 1.67 → max speed bonus 40 and max 140/question in every section); base 100, grace block 5000ms. `wrong_penalty` column is retired (kept, unread) — the penalty is derived in `submit_answer` since `20260715000000`.
- `rating_history` — append-only ELO timeline (null match_id = season reset row); powers the profile graph.
- `challenges` — invite codes (pgcrypto), 15-min expiry, `is_rated` + `section_mode` fixed at creation.
- `seasons` / `season_results` — monthly-ish soft resets; world-readable.
- `friendships` — ordered-pair PK (`user_a < user_b`), status pending/accepted; RLS enabled with **zero policies** (definer RPCs only).
- `match_events`, `rpc_rate_limit`, `ip_rate_limit` — RLS enabled, zero policies (server-only).
- `waitlist` — `email` unique + survey fields; anon INSERT-only with validation, no client read, duplicate email is a no-op success. Postgres is the sole store (Google Sheets webhook removed 2026-07-01 after silently 401ing). View in Supabase Studio or `/admin/waitlist`.
- `ai_config` — **one row** (`id boolean primary key check (id)`), read at request time so an admin model switch needs no deploy. Non-secret routing only; the key lives in env. `provider` was dropped 2026-07-17 — OpenRouter is the only provider. RLS on, zero policies (definer-only).
- `ninja_responses` / `ninja_debriefs` / `ninja_daily_focus` / `ninja_coach_messages` — Ninja output, all RLS-on/zero-policies (definer-only). The debrief and daily rows are **cost caches, not conveniences**: a repeat read returns the stored row and never re-bills.

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
Nudged on every real answer in a **rated or bot** match inside `submit_answer` (unrated *player-vs-player* matches never nudge — uncapped unrated challenges were a collusion channel into the bank; you can't collude with the bot, and it's the cold-start tool whose own difficulty reads `q.elo`, so gating it on `is_rated` left the bank frozen at its seeds — `20260716160000`). Only the human's submission nudges in a bot match; `bot_act` deliberately never does, since the bot's answer derives *from* `q.elo`. One atomic UPDATE, clamp [400, 2800], K=32 while `times_seen < 20` else 16, result `0.35 × (taken_ms/cap)` for correct / `1.0` for wrong; any implausibly-fast (<2s) answer is excluded, correct or wrong (`fast_answer` telemetry stays correct-only). Selection biases toward the players' average ELO with `random()×300` jitter; VARC/DILR prefer one active passage group (≥3 active sub-questions, nearest mean-ELO) with standalone fallback; QUANT picks 3 standalone. Constants backed by `scripts/simulate-question-elo.mjs`; invariants tested by `scripts/elo-stress-test.sql`.

### Question embeddings (pgvector, `20260716180000`)
**The single source of truth for embeddings — everything else on the topic points here.**

`questions.embedding vector(1536)` — `openai/text-embedding-3-small` over `body` only, via **OpenRouter** on the same key and base URL as every chat call. It proxies OpenAI's embedding models on `/api/v1/embeddings` even though its `/api/v1/models` catalog lists **zero** of them, so a catalog search is not evidence it's unsupported. Both `openai/text-embedding-3-small` and the bare `text-embedding-3-small` return 200/1536-d (verified 2026-07-17) — the prefixed id is a consistency choice, not a requirement; earlier docs claiming the bare name 404s were wrong. Anthropic publishes no embedding model at all, so there is no Claude option for this slot; `ai_config` governs the *chat* model (GLM) and is unrelated. Changing the model means a migration + full re-embed, not a config edit.

- **`scripts/backfill-embeddings.mjs` is the only writer.** Idempotent — selects `embedding is null` only, so re-running it *is* the repair path. `embedInput()` is the contract: read-time query embedding **must** call it or the query vector lands in a different space and similarity is quietly garbage. Guarded by `isMain`, so importing that function doesn't trigger a backfill.
- **Staleness is a trigger, not a caller's job.** `questions_null_stale_embedding_trg` (`before update of body`) nulls the embedding on any real body change, from any writer — `admin_upsert_questions`, `admin_update_question_options`, and anything future. It doesn't fire on `submit_answer`'s elo/times_seen UPDATE, so the match hot path pays nothing.
- **`search_questions(embedding, section, limit, exclude)` returns IDS ONLY, never bodies** — and is granted to `service_role` only. `questions` is RLS `using(false)` and every body-serving RPC is reached-guarded; an endpoint returning question text for a caller-supplied embedding is a bank-scraping oracle. **No consumer is wired yet.** When one is: pass a server-derived embedding, not caller-supplied text (the similarity score is a "how close is my guess" oracle even without bodies), and note Supabase's default privileges grant EXECUTE to `authenticated` on every new function — revoking `public, anon` alone leaves that standing.
- **Storage is `PLAIN`, deliberately — and the ALTER alone does not achieve it.** pgvector defaults vector columns to EXTERNAL, putting every 6148-byte embedding in TOAST; the exact scan then pays a detoast per row (677ms/7693 buffers TOASTed → 4.8ms/1372 inline, measured at 1247 rows on 2026-07-17). `attstorage` only governs rows written *after* the ALTER, and on this DB the MCP-applied copy of the migration landed before the ALTER existed, so the whole bank was TOASTed and the 6x claim was never real until it was rewritten. **`update questions set embedding = embedding` is a silent no-op** — assigning a column to itself passes the same toast pointer through, Postgres sees an unchanged external datum and skips re-toasting, so PLAIN is never consulted. Force a fresh datum: `update questions set embedding = (embedding::text)::extensions.vector(1536) where embedding is not null;` then `vacuum (analyze) questions;` (verified lossless on all 1255 rows before writing). Full note in `20260716180000`. No HNSW index — exact search has no recall loss and doesn't earn one at this size.

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

### Ninja AI (`lib/ai/*`, `app/api/ninja/*`, `ai_config`)
**No LLM of any kind while the caller is in a match.** `lib/ai/live-match.ts::inLiveMatch` gates **all five** user-facing routes — `ask`, `coach`, `solve`, `daily`, `debrief`.

**The rule keys on the CALLER, not on the match the request names — that distinction is the whole point.** Every per-match RPC guard (`get_question_for_ninja`'s `match still active`, `get_debrief_data`'s `match not finished`) only inspects the match in its own arguments. Mid-match, an ask or debrief aimed at an **old completed match** passes those guards untouched: tab two, an LLM solving CAT questions while your live match runs. So the RPC guards are *not* redundant cover for the gate and the gate is *not* redundant cover for them — they stop different attacks. Don't delete either as duplicate. `coach`/`solve` were the widest holes (both take arbitrary input — paste the live question, or screenshot it into a PDF); `daily` takes no input and isn't a cheat channel but rides the rule so there's one definition.

Live = the notion `join_queue` uses: caller in a match with `status in ('active','pending')`, read through `matches`'s participants-only RLS, no new RPC. **Fail-closed** — a read error blocks the call, matching the metered-LLM limiters. Guarded by `scripts/ninja-guard-test.sql` sections 6 and 8; add any new user-facing route to the gate. Admin routes (`generate`/`audit`/`distractors`/`extract`/`anticheat`) are deliberately ungated — they're `is_admin`-only, not a player-reachable cheat channel.

**One provider: OpenRouter. One key: `OPENROUTER_API_KEY`.** There is no OpenAI-direct path — `ai_config.provider` and the `getModel(provider, id)` switch were removed in `20260716190000_openrouter_only`. Switching upstream = editing the model id in `/admin` (`z-ai/…`, `google/…`, `openai/…`), no deploy. `@ai-sdk/openai` is still the client package: OpenRouter speaks the OpenAI wire format, so the package name is about protocol, not billing.

**`ai_config` is a one-row table read at request time.** Live (2026-07-17): `model_id = z-ai/glm-5.2`, `fallback_model_id = google/gemini-2.5-flash-lite`, `temperature 0.3`, `max_tokens 4000`. Every route does `[model_id, fallback_model_id].filter(Boolean)` and loops, so a null fallback is just a one-element list.

**What the fallback does and doesn't buy.** It is NOT availability insurance: OpenRouter already load-balances and fails over across **28 upstream providers** for `z-ai/glm-5.2` alone. What it covers is the failure mode OpenRouter can't — glm-5.2 returning *empty content* because reasoning tokens ate `maxOutputTokens` (see below). That only works if the loop treats empty text as a failure: every route must `if (text) break`, never break unconditionally. `/api/ninja/ask` broke unconditionally until 2026-07-17 and its fallback was dead code — verified live that day: a TITA solve emits 1210–1521 output tokens, so an under-sized cap is a real, not theoretical, empty-content path. The trade is real — the fallback answers with a different model than the one you evaluated, so a glm-5.2 quality bar isn't what ships when it fires. `20260716190000`'s "fallback_model_id is null by intent" is superseded by this row; the reasoning there against the *original* fallback still stands: `google/gemini-2.0-flash-001` was **silently delisted**, making every fallback iteration a guaranteed throw. **Check any model id against `curl https://openrouter.ai/api/v1/models` before pinning it — nothing validates it at startup.**

**glm-5.2 emits reasoning tokens. This is the #1 footgun here.** They bill as completion ($2.97/Mtok) *and* consume `maxOutputTokens` **before** any answer text. Measured: "2+2" → 83 reasoning of 108 completion; a real CAT quant solve → 224 of 417; at a 300 cap, `content` came back **null**. So **never size `maxOutputTokens` to the visible answer** — leave room for the trace and truncate the text afterward (`/api/ninja/daily` does exactly this: it needs one 140-char line but asks for `max(max_tokens, 1200)`). `reasoning:{enabled:false}` cuts a solve 68% and still answers correctly; deliberately NOT enabled — it's an unmeasured quality trade on hard DILR/Quant. `effort:"low"` does nothing useful.

**glm-5.2 is text-only.** `/api/ninja/{solve,extract}` send PDF file parts, so OpenRouter transparently runs its default **mistral-ocr** shim: **$2/1000 pages on top of tokens**, ~38% of a solve's cost and the most expensive thing in the repo. Escape hatches in `lib/ai/extract.ts`.

**Cost shape** (measured 2026-07-16, glm-5.2 at $0.944/$2.97 per Mtok): ask ~$0.0012–0.005/call (upper end measured 2026-07-17 on TITA: 189–236 in, **1210–1521 out** — reasoning trace + worked solution + the distractor explanation. Output is 2–3x the old 417-token sample, which is why `max_tokens` must stay at 4000; a 1200 cap truncates a normal TITA solve. Reproduce with `node scripts/ninja-live-probe.mts`) · debrief ~$0.0014 (cached per match, first-write-wins) · daily ~$0.0008 (cached 1/day) · coach **$0.007–0.043** (agentic, `stepCountIs(6)`, replays the transcript each step — cost is quadratic in turns, and `get_my_profile` returns an *unbounded* rating curve) · solve **$0.06–$0.31** per PDF (15 chunks at 60 pages) — the single most expensive user action. Every route is rate-limited per-user **and** per-IP, fail-closed; `ask` is additionally capped at 3 attempts per (match, question, user) in `get_question_for_ninja`, which is the only thing making its 15/min limiter safe. Don't remove it.

**Embeddings also go through OpenRouter** — same key, same base URL, `openai/text-embedding-3-small`. So this section's "one provider, one key" rule covers the whole AI surface, chat and embeddings alike. Everything else about them (why the catalog lists none, why there's no Claude option, the `embedInput` contract, the ids-only search rule) lives in **Question embeddings** above — one place, don't restate it here.

### Caching pattern
Public pages (leaderboard, profile) use `createPublicClient()` (cookieless, `persistSession:false`) + `revalidate=60` ISR; "(you)" highlighting is resolved client-side to keep the page cacheable. Auth-dependent pages are `force-dynamic`.

## RLS rules
- `questions` / `passages`: `using (false)` — served only via definer RPCs.
- `profiles`: world-readable; self-update with server-owned columns frozen via WITH CHECK.
- `matches`: participants only. `match_answers`: **own rows only** (`20260716160000`) — the old participants-scoped policy let you read the *opponent's* row while the question was still open, and TITA's `answer_text` is plaintext, so whoever answered first handed the other the answer. Never widen it back: every opponent-facing read (`get_answer_reveal`, `get_debrief_data`, the spectator RPCs) is definer and bypasses RLS. `rating_history`: own rows. `seasons`/`season_results`/`section_config`: public read.
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

**Both production projects build `main`.** Staging is not a branch — it is a second project off the same branch with different env vars. Don't reach for branches to change what staging runs; reach for that project's env vars.

**The `test` branch does NOT feed `test.ninjatest.app`** — the names collide, and that has already caused wrong conclusions. `test.ninjatest.app` is `ninjatest-flbe`'s *production*, which builds `main`. Pushing `test` only produces previews:

| Push to | `ninjatest` | `ninjatest-flbe` |
|---|---|---|
| `main` | **cancelled** by the guard — production stays frozen | **production** → `test.ninjatest.app` |
| `test` (or any branch) | preview → `ninjatest-git-*.vercel.app` (Vercel-SSO-gated) | preview → `ninjatest-flbe-git-test-*.vercel.app` (Vercel-SSO-gated) |

So the only place `test`-branch code is viewable is that SSO-gated preview URL, behind your Vercel login. The branch is kept for short-lived work; to put something in front of `test.ninjatest.app`, it has to land on `main`.

### Release flow (deliberately one-way)
A push to `main` deploys **staging only**. `vercel.json`'s `ignoreCommand` is the guard — it exits 0 (skip) / 1 (build), and skips exactly one thing: a **production** build of **`ninjatest`** without the escape hatch. Everything else builds, previews included.

Both allowlist tests (`= preview`, and staging by project id) are written that way rather than as blocklists (`!= production`, `!= ninjatest`), and the direction is load-bearing: `vercel.json` is shared by both projects, so if `VERCEL_PROJECT_ID` or `VERCEL_ENV` were ever unavailable, a blocklist would fail *open* and auto-deploy production. This fails closed — the production path skips, which is loud and safe. Keep the guard here, not in project settings: the dashboard's Ignored Build Step is deliberately unset so there is exactly one source of truth.

Verify what you shipped on `test.ninjatest.app`, then go live **once**:
1. Add `ALLOW_PROD_DEPLOY=1` to `ninjatest` Production (the `ignoreCommand` escape hatch).
2. Remove `NEXT_PUBLIC_APP_MODE` from `ninjatest` Production — this is the waitlist→app flip; the landing stops being the front door and `/` redirects authed users to `/lobby`.
3. Redeploy `main`, confirm `www.ninjatest.app`.
4. Remove `ALLOW_PROD_DEPLOY` to refreeze production.

Because both projects build the same branch, step 3 ships the exact commit staging validated. `ALLOW_PROD_DEPLOY` is a no-op on staging (already allowlisted), so setting it on the wrong project cannot un-freeze anything.

Traps, all learned the hard way:
- **`test.ninjatest.app` is NOT a preview of `ninjatest`.** It is `ninjatest-flbe`'s *production*, so `VERCEL_ENV === "preview"` is false there. Gating staging behaviour on `VERCEL_ENV` is a silent no-op.
- **`ninjatest-flbe` answers on two public hostnames**, so a hostname check on `test.ninjatest.app` leaves `ninjatest-test.vercel.app` serving the same thing. Gate on a project-scoped env var instead.
- `ninjatest-flbe` has no `NEXT_PUBLIC_APP_MODE` — undefined `!== "waitlist"`, which is *why* it runs the full app.
- Per-commit `*.vercel.app` preview URLs are Vercel-SSO-gated; the two hostnames above are not.
- `vercel env pull` redacts every value to `""`. To find out what a deployment actually does, curl it.
- **`main` is not "production" in the usual sense** — it is the staging trunk. Pushing it is safe and expected; it does not reach `ninjatest.app`.
- The build guard is in `vercel.json`; the **project split, domains, and env vars are not** — they live in Vercel project settings, and this file is their only record.
- `vercel.json` is shared by every project building this repo. Anything added there (headers, rewrites, crons) hits production *and* staging — scope it on `VERCEL_PROJECT_ID`, as `ignoreCommand` does.

## Environment
| Var | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | |
| `NEXT_PUBLIC_APP_MODE` | `ninjatest` Production only | `waitlist` = landing-only front door. Absent everywhere else → full app. |
| `NEXT_PUBLIC_SITE_URL`, `RESEND_API_KEY` | all | email links + Resend |
| `OPENROUTER_API_KEY` | `lib/ai/model.ts`, both backfill scripts | **The only LLM key.** Every Ninja call — chat *and* embeddings — routes through OpenRouter. There is no OpenAI-direct path; switching upstream = changing the model id prefix in `/admin` (`z-ai/…`, `google/…`, `openai/…`). |
| `ADMIN_ENABLED` | admin deployment + `.env.local` | `=1` makes middleware serve **only** the console: `/` → `/admin`, every other path 404s. Set locally, so `/` will NOT render the landing on your dev server — run `ADMIN_ENABLED= npm run dev` to see it. Elsewhere `/admin*` 404s. |
| `PRIVATE_LEADERBOARD` | `ninjatest-flbe` only (Prod + Preview) | `=1` drops `/leaderboard` from `isPublicRoute` so the staging board isn't publicly browsable. **Never set it on `ninjatest`** — that would make the real leaderboard auth-only and forfeit its ISR caching. |
| `ALLOW_PROD_DEPLOY` | `ninjatest` Production, **only while promoting** | `=1` bypasses `vercel.json`'s `ignoreCommand` so production actually builds. Read by the build guard, not by app code. Remove it after the deploy or production is auto-deploying again. |
| `SUPABASE_SERVICE_ROLE_KEY` | local ingest scripts only | never in app code |

`.env.local.example` is current as of 2026-07-17 (rewritten to match this table; the unused `NEXT_PUBLIC_APP_URL` is gone). `DEV_BYPASS`/`NEXT_PUBLIC_DEV_BYPASS` in `.env.local` are referenced nowhere — safe to delete.

**A shell export of `OPENROUTER_API_KEY` silently shadows `.env.local`** — `process.env` wins over the file and OpenRouter answers a bare `User not found.` naming neither the key nor its source. Cost real time twice: 2026-07-16 (a `~/.zshrc` export) and 2026-07-17 (the same dead key still living in an already-running process after `~/.zshrc` was fixed).

- **The scripts are immune as of 2026-07-17.** The backfill scripts call `loadEnvLocal()` (`scripts/env.mjs`) instead of `process.loadEnvFile()`, which refuses to override an already-set var. Use it in any new script under `scripts/`. `.env.local` wins and any conflict prints one line naming both suffixes. They are local-only, so the file is the truth; Vercel has no `.env.local` and is unaffected. `node scripts/env.mjs --self-test` guards it.
- **`npm run dev` is still exposed** — Next.js will not let a file override `process.env`, and that is correct on Vercel. Don't export LLM keys in your shell; `~/.zshrc:8` carries a comment saying so.
- **Diagnose the *process*, not the login shell.** `env -i HOME=$HOME zsh -lic 'echo $OPENROUTER_API_KEY'` only proves your rc files are clean — a process that inherited a stale export before you fixed them keeps it until restarted, and that gap is exactly what made this look resolved when it wasn't. Check the env you're actually in (`echo ${OPENROUTER_API_KEY:0:14}`) and compare against `.env.local`. Fix by restarting the process **from a new terminal**; relaunching from the same stale one re-inherits it. `launchctl getenv OPENROUTER_API_KEY` catches the reboot-persistent variant that no rc file shows.

## Known dead code / drift
- `components/Aurora.tsx`, `components/error-boundary.tsx`, `components/ui/dropdown-menu.tsx` — unreferenced.
- `lib/supabase/types.ts` lags migrations → `as any` casts scattered through clients.
