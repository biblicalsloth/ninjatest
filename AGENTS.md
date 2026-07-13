# AGENTS.md — Ninjatest

Instructions for any coding agent working in this repo. Full architecture reference: `CLAUDE.md`. Design system: `DESIGN.md`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## What this is

Real-time 1v1 CAT-prep battle app. Next.js 16 (App Router; `proxy.ts`, not `middleware.ts`) + Supabase (Postgres/Auth/RLS/Realtime). All game logic lives in Postgres `SECURITY DEFINER` RPCs under `supabase/migrations/`; the app layer is a thin client. Currently front-doored by a waitlist landing page (`NEXT_PUBLIC_APP_MODE=waitlist`).

## Hard rules

1. **Server authority.** Never move scoring, timing, ELO, matchmaking, or answer validation into client or route-handler code. It belongs in an RPC. Clients call RPCs and render.
2. **Option-shuffle invariant.** `get_match_question`, `submit_answer`, and `get_answer_reveal` must all use the same `option_perm()` mapping. Changing one without the other two silently scores answers against options the player never saw. This has regressed once already.
3. **Migrations: never `CREATE OR REPLACE` from a stale copy.** Grep all migrations for the function name and start from the *last* definition — three past regressions came from recreating functions off old bases. Re-verify partner functions of any invariant you touch.
4. **New definer functions**: pin `set search_path = pg_catalog, public` inline (add `extensions` if using pgcrypto), `REVOKE ... FROM public, anon` then grant `authenticated, service_role` explicitly, and wrap `auth.uid()` as `(select auth.uid())` in any RLS policy.
5. **Scoring constants live in `section_config`** (and per-question `duration_ms`). Never hardcode caps, points, multipliers, or penalties in app code.
6. **Broadcast vs DB**: realtime broadcast carries liveness signals only (never scores, correctness, or the opponent's answer). Postgres Changes carry authoritative state. Clients rehydrate from the DB on reconnect.
7. **Email routes keep their authorization checks** (`/api/email/challenge` verifies challenge ownership; `/api/email/result` verifies match participation, sends only to the caller's auth email). The unauthorized-relay variant was a real security finding.
8. **Don't subscribe anonymous visitors to realtime** (landing page has no online-count on purpose — one WebSocket per visitor is a billing risk).

## Conventions

- **UI**: dark-only, `#120F17` page / `#111111` cards / mint `#06d6a0` sole CTA color, Geist Mono everywhere. Existing components use raw hex Tailwind arbitrary values (`text-[#7ab5cc]`) — match that idiom; don't refactor to token classes mid-file. Section and league colors come from `getSectionBadgeClass` (`lib/utils.ts`) and `getLeague` (`lib/leagues.ts`); never restate the hexes.
- **Public pages** (leaderboard, profile) use the cookieless `createPublicClient()` + ISR `revalidate=60`; per-viewer bits ("you" highlight, own-profile actions) resolve client-side to keep pages cacheable.
- **Rate limiting** is Postgres-backed and durable: `check_rate_limit` (per-user, raises) inside RPCs, `check_ip_rate_limit` (per-IP, returns retry-after; fail-open) via `lib/rate-limit.ts` in route handlers.
- **Types**: `lib/supabase/types.ts` lags the schema; prefer regenerating types over adding more `as any` casts.

## Verify

```bash
npm run lint && npx tsc --noEmit && npm run build
# DB invariants (rolls back, but inserts auth.users — branch/local DB only):
psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/elo-stress-test.sql
```

The stress test covers: shuffle round-trip, a full 9-question match through real RPCs, reveal consistency, zero-sum ELO, overlapping-match rating chains, and the 100-ELO floor. Run it after touching any match/rating/shuffle RPC.
