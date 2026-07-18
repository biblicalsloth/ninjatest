# Debug session: Ninja AI chat is built but unreachable, and confirm GLM-5.2 is live

Two problems, one session. Read `CLAUDE.md` first — especially **Ninja AI**, **Routes (actual)**, and **Deployments**. Do not skip it; most of the traps below are already documented there.

---

## Problem 1 — the ChatGPT-like Ninja page exists in code but not in the UI

`app/ninja/chat/chat-client.tsx` (15.6K) is fully built: three modes (`coach` / `buddy` / `plan`) against `POST /api/ninja/coach`, with turns persisted to `ninja_coach_messages` via `save_ninja_coach_turn` and reloaded through `get_coach_conversation` / `get_recent_coach_turns`.

**Nothing links to it.** `grep -rn "/ninja/chat"` across the repo returns zero hits outside the route folder itself. The nav dock (`components/side-nav.tsx:90`) has exactly one Ninja entry:

```tsx
<DockItem href="/ninja" label="Ninja AI" icon={<NinjaLogo .../>} pathname={pathname} />
```

and `/ninja` renders `app/ninja/ninja-history-client.tsx` — a read-only history list of past Ninja output grouped by match/practice session. That is why the chat looks missing: the wired nav item goes to the archive, not the conversation. The only other entry point is `openNinjaCoach` (`components/side-nav.tsx:97` → `lib/ninja.ts` → `components/ninja-coach.tsx`), a floating panel — not a page.

### What to do

Make the already-wired `/ninja` nav item land on the chat. Decide between these and justify the pick in one line:

- **A**: `/ninja` becomes the chat page; history moves to `/ninja/history` and is reachable from a link inside the chat page.
- **B**: `/ninja` keeps the history list but gets a prominent link/tab to `/ninja/chat`.
- **C**: `/ninja` becomes a two-tab shell (Chat | History), both client components already exist.

Prefer whichever gives the shortest diff that puts the conversation behind the existing dock icon. Do **not** add a new nav item — the ask is explicitly to use the one already wired. Do **not** rewrite `chat-client.tsx`; it is built and works. This is a routing/entry-point fix, not a feature build.

### Verify (do not report done without this)

1. `.env.local` carries `ADMIN_ENABLED=1` **and** `NEXT_PUBLIC_APP_MODE=waitlist`, so a bare `npm run dev` serves only the admin console and the proxy bounces `/ninja` to `/`. Both are strict-equality checks and `@next/env` treats an empty string as unset — `ADMIN_ENABLED= npm run dev` silently does nothing. Pass non-empty sentinels: `ADMIN_ENABLED=0 NEXT_PUBLIC_APP_MODE=live npm run dev`.
2. A 307 to `/` does **not** prove the mode is still on — an unauthed request to any app route also 307s (`!isAuthed && !isPublicRoute`). Distinguish the two before concluding anything.
3. Sign in, click the Ninja dock icon, land on the chat, send a turn in each of the three modes.
4. Reload the page. **Prior turns must still be there** — that is the "responses saved" half of the ask, and it is the half most likely to be quietly broken. If they vanish, trace `get_coach_conversation` and the thread id the client sends.
5. Confirm the **plan** mode UI is a single button, not a textarea. `/api/ninja/coach` overrides whatever question you send in `plan` mode with a fixed string and skips thread history — a free-text box there silently discards what the user typed.

---

## Problem 2 — confirm GLM-5.2 is actually powering it

`ai_config` is a one-row table read at request time, so what ships is whatever that row says, not what any file says. Check the live row, do not trust the docs:

```sql
select model_id, fallback_model_id, temperature, max_tokens from ai_config;
```

Expected (per CLAUDE.md, as of 2026-07-17): `z-ai/glm-5.2`, fallback `google/gemini-2.5-flash-lite`, temp `0.3`, max_tokens `4000`.

Then confirm each of these, and report the actual value found for every one:

- **`ai_config.provider` is gone.** OpenRouter is the only provider (`20260716190000_openrouter_only`). If a `provider` column or a `getModel(provider, id)` switch still exists anywhere, that is drift — flag it.
- **The model id resolves.** `curl https://openrouter.ai/api/v1/models | grep glm-5.2` — nothing validates the id at startup, and a silently delisted model makes every call throw. This exact failure already shipped once with `google/gemini-2.0-flash-001`.
- **`max_tokens` is 4000 and stays there.** GLM-5.2 emits reasoning tokens that consume `maxOutputTokens` *before* any answer text. A real TITA solve measures 1210–1521 output tokens. A 1200 cap truncates a normal solve and returns **empty content**, not an error.
- **Every route in the fallback loop does `if (text) break;`, never an unconditional break.** The fallback's only real job is catching empty-content-from-reasoning-overrun — an unconditional break makes it dead code. `/api/ninja/ask` had exactly this bug until 2026-07-17. Check `/api/ninja/coach` specifically, since that is the route the chat page uses.
- **The key is not shadowed.** A shell export of `OPENROUTER_API_KEY` beats `.env.local` and OpenRouter answers a bare `User not found.` naming neither the key nor its source. This has cost real time twice. Check the env of the process you are actually in — `echo ${OPENROUTER_API_KEY:0:14}` — and compare to `.env.local`. A clean login shell proves nothing; a dev server started before the fix keeps the stale value until restarted **from a new terminal**. `launchctl getenv OPENROUTER_API_KEY` catches the reboot-persistent variant.

Live end-to-end probe (spends ~$0.004/question, reproduces the real model path):

```bash
node scripts/ninja-live-probe.mts --dry-run   # prints prompts, calls nothing
node scripts/ninja-live-probe.mts             # real call, grades against answer_value
```

---

## Guardrails

- **The live-match gate is not optional.** `lib/ai/live-match.ts::inLiveMatch` blocks `ask`/`coach`/`solve`/`daily`/`debrief` while the caller is in an `active`/`pending` match. It keys on the **caller**, not the match named in the request — the per-match RPC guards do not cover this and are not redundant with it. If the chat page's entry point changes, re-run `psql "$DB_URL" -f scripts/ninja-guard-test.sql` (sections 6 and 8 guard the gate). Never route around it "just for chat" — `coach` takes arbitrary input, so it is the widest cheat channel in the app.
- **Coach is the most expensive per-call route**: $0.007–0.043, agentic at `stepCountIs(6)`, replays the transcript each step, so cost is quadratic in turns. Making it easier to reach is the point of this session — do not also make it cheaper to abuse. Leave the per-user and per-IP limiters alone.
- **`main` is production.** A push to `main` deploys `www.ninjatest.app` (waitlist) *and* `test.ninjatest.app` (full app) off the identical commit, in ~2 minutes, with no promote step. Test on a branch preview or locally **before** merging. Any habit that says "main is just staging" predates 2026-07-17 and is wrong.
- If any migration is needed: `supabase db push`, never MCP `apply_migration` (it records the apply-time version, not the file prefix, and drifts the tracking table). Run `supabase projects list` first — if `ftdbmubdddgcoprqxxxs` is not listed, the CLI is on the wrong account and every command 403s for reasons no grant will fix.

## Deliverable

The Ninja dock icon opens a working, persistent, ChatGPT-like chat page, and a short written confirmation of what `ai_config` actually holds live — with the measured value for each bullet in Problem 2, not a restatement of what this document expects.
