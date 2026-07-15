# Task: Solidify login/logout state

Make the two guarantees below hold with no gaps. Server-authoritative auth is
already in place (`lib/supabase/middleware.ts` via `proxy.ts`, live mode) — this
task closes the client-side and cache holes, it does NOT rebuild the gate.

## Guarantees

1. **Stay logged in.** After a successful login, the user remains in the app
   across navigation, refresh, and token expiry — until they explicitly log out.
   No spurious bounces to `/` or `/auth/login` while a valid session exists.
2. **Stay logged out.** After logout, no protected screen is reachable — including
   via the browser **Back button / bfcache**, a second tab, or a restored session.
   Reaching any app route requires logging in again.

## Current state (read before touching)

- `lib/supabase/middleware.ts::updateSession` — the only server gate. Live mode:
  unauthed + non-public route → redirect `/`; authed on `/auth/*` → `/lobby`;
  onboarding chokepoint with `nt_onboarded` cookie cache.
- Logout: `app/lobby/lobby-client.tsx:97` — `supabase.auth.signOut()` then
  `router.push("/auth/login")`. This is the ONLY logout call site.
- Protected pages are RSC using `supabase.auth.getUser()` (server).
- There is **no** client `onAuthStateChange` subscription in the app.

## Known gaps to fix (root-cause, not per-page patches)

1. **bfcache Back-button leak (primary).** After logout, Back restores the last
   authed page from bfcache without re-running middleware → user sees an authed
   screen. Fix at one chokepoint: set `Cache-Control: no-store` (and
   `no-cache, must-revalidate`) on authenticated responses so the browser skips
   bfcache for them. Prefer setting it in `updateSession` on the authed branch
   rather than per-page. Verify Back after logout lands on `/` or `/auth/login`.
2. **No reactive auth listener.** Add a single `supabase.auth.onAuthStateChange`
   subscription (one shared client component mounted app-wide — e.g. reuse
   `components/app-nav.tsx` or `ninja-coach-mount.tsx`, do NOT add a new provider
   if an existing always-mounted client component fits). On `SIGNED_OUT` (fires
   cross-tab too) → hard-redirect to `/auth/login`. This covers token expiry and
   logout in another tab.
3. **Logout cleanup.** On sign-out also clear the `nt_onboarded` cookie so a next
   user on the same browser can't skip the onboarding gate. Route logout through
   the same path as the listener so there's one logout behavior, not two.

## Constraints

- Server stays authoritative. The middleware redirect is the real gate; client
  changes are defense/UX, never the sole check.
- No new dependencies. Use the existing `@supabase/ssr` clients and Next.js.
- Smallest diff that closes all three gaps. One listener, one header change, one
  cookie clear — not a rewrite.
- Follow `CLAUDE.md`: dark-only UI, `supabase as any` cast idiom where types lag.

## Acceptance (manual, live mode — `NEXT_PUBLIC_APP_MODE` unset/`live`)

1. Log in → land in app → refresh `/lobby` → still in. ✅ no bounce.
2. Navigate around, hard-refresh a protected page → still authed.
3. Log out → press browser Back repeatedly → never shows an authed screen;
   always `/` or `/auth/login`.
4. Two tabs logged in → log out in tab A → tab B redirects to login on next
   interaction/focus (no protected content served).
5. Directly hit `/lobby` while logged out → redirected to `/`. (already works —
   confirm still works.)
