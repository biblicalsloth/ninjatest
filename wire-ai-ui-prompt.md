# Prompt: Wire all AI capabilities into the UI

Paste everything below this line into Claude Code.

---

Wire every AI (Ninja) capability into the app's navigation and pages. This is a **UI-only task** — do not touch any migration, RPC, or `/api/ninja/*` route handler; every backend already exists and works. Read `CLAUDE.md` and `DESIGN.md` first and match the existing idiom exactly (dark-only, raw hex arbitrary values like `text-[#7ab5cc]`, mint `#06d6a0` as the only CTA color, Geist Mono, cards `#111111` on bg `#120F17`).

## Current state (verified)

- `components/app-nav.tsx` — sticky navbar mounted once in `app/layout.tsx`, gated by a `SHOW` route allowlist. It currently renders **only** the logo and the online-count pill. No links of any kind.
- `components/ninja-coach.tsx` — the "Ninjachat" freeform coach (POST `/api/ninja/coach`). Mounted **only** in `app/lobby/lobby-client.tsx:324`. Two states: collapsed badge (bottom-right) ↔ 400px panel.
- `components/ninja-pill.tsx` — per-question solver, mounted on the result page, opened via the `ninja:ask` window event (`lib/ninja.ts`). Correctly absent during live matches (asks are blocked server-side while a match is active). Leave its placement alone.
- `components/ninja-debrief.tsx` (result page) and `components/ninja-daily-focus.tsx` (lobby) — already wired. Leave alone.
- Practice mode lives at `/practice`; the only entry is a lobby card. Bot matches (`match_with_bot` RPC) are only reachable via a fallback button on `/queue` (`handlePlayBot` in `app/queue/page.tsx`).
- Admin AI tools (generate, distractors, audit, anticheat, model config) are fully wired in `/admin`. Leave alone.

## Task 1 — Navigation links in `components/app-nav.tsx`

Add a link row to the navbar (between logo and online pill): **Arena** (`/lobby`), **Practice** (`/practice`), **Spectate** (`/spectate`), **Leaderboard** (`/leaderboard`), **Friends** (`/friends`), **Settings** (`/settings`). Active route gets mint text (`text-[#06d6a0]`); inactive `text-[#7ab5cc] hover:text-white`. Use `usePathname()` (already imported). On small screens show icons only (Lucide, size 18) with `aria-label`s; labels appear from `sm:` up. Keep the existing `SHOW` allowlist and the authed-only online pill untouched.

Also add an **Ask Ninja** button in the nav (NinjaLogo icon + label, mint accent) that opens the global coach — see Task 2 for the mechanism.

## Task 2 — Make Ninjachat (Ninja Coach) global, with a three-state popup

Move `<NinjaCoach />` out of `lobby-client.tsx` and mount it once in `app/layout.tsx` next to `<AppNav />`, wrapped in the same kind of route gating as the nav:

- Show only on nav-visible routes **minus** `/queue` and `/result` (result already has NinjaPill in the bottom-right corner — don't stack two floating pills; queue is a handoff screen). Concretely: lobby, practice, spectate index, leaderboard, friends, settings, profile.
- Render only for authed users (same `createClient().auth.getUser()` pattern the nav uses). Never mount it for anonymous visitors — no LLM-backed surface for anon.
- It must stay unmounted on `/match/*` and `/spectate/[matchId]` (the SHOW-list approach already guarantees this).

Rework `components/ninja-coach.tsx` from two states to **three**:

1. **Collapsed badge** — exactly as today (bottom-right pill).
2. **Panel** — today's 400px bottom-right window. Header gains an **expand** button (Lucide `Maximize2`).
3. **Expanded popup** — a centered fixed overlay: `fixed inset-0 z-50` with a `bg-black/60` backdrop, dialog `w-[min(92vw,720px)] h-[min(80vh,640px)]` using the same `#111111` card styling. Header shows **minimize** (Lucide `Minimize2`, back to panel) and the existing chevron **collapse** (back to badge). Clicking the backdrop and pressing Escape return to the panel state. `role="dialog" aria-modal="true"` on the expanded container.

Conversation state (`turns`) must survive all state transitions — it already does because the component stays mounted; keep it that way (one `useState<"closed" | "panel" | "expanded">` replaces the boolean).

Opening from the nav: reuse the repo's existing decoupled-event pattern (`lib/ninja.ts` is the reference). Add to `lib/ninja.ts`:

```ts
export const NINJA_COACH_EVENT = "ninja:coach";
export function openNinjaCoach() {
  window.dispatchEvent(new Event(NINJA_COACH_EVENT));
}
```

The nav button calls `openNinjaCoach()`; `NinjaCoach` listens and goes to `panel` state (or `expanded` if already in `panel` — a second click grows it). Do **not** introduce a context provider or state library for this.

## Task 3 — Bot match entry in the lobby

In `app/lobby/lobby-client.tsx`, add a **"Vs Ninja Bot"** card to the existing mode grid (same card idiom as Practice/Spectate — Lucide `Bot` icon, mint accent, subtitle like "Instant match · unrated · adapts to your ELO"). On click: call `match_with_bot` via the supabase client (copy the exact pattern from `handlePlayBot` in `app/queue/page.tsx:195-207` — on error, `toast.error` and reset; on success, `router.push(\`/match/${data}\`)`). Disable the button while starting. Keep the existing queue-page bot button as-is.

## Task 4 — Daily Focus placement check (no new code expected)

`NinjaDailyFocus` renders inside the lobby dailies card. Verify it still renders after your lobby edits; do not move it.

## Constraints

- `lib/supabase/types.ts` lags migrations — match the existing `(supabase as any).rpc(...)` cast idiom for any RPC call; do not regenerate types in this task.
- No new dependencies. No shadcn Dialog for the coach popup — hand-rolled fixed overlay matches the existing NinjaPill/NinjaCoach style.
- Don't add the coach or any AI surface to the landing page (`landing-client.tsx`) — waitlist mode is the public front door and must stay free of authed-only widgets and extra WebSockets.
- Accessibility: every icon-only button gets `aria-label`; Escape handling on the expanded popup; focus the input when the panel/popup opens.

## Verify

`npm run lint` and `npx tsc --noEmit` must pass. Then run the app and check: nav links + active states on lobby/practice/leaderboard; Ask Ninja opens the coach from the leaderboard page; badge → panel → expanded → panel → badge round-trip keeps chat history; Escape closes expanded; no coach on `/match/*`, `/queue`, `/result`, or when signed out; lobby bot card starts a match.
