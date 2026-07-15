# Ninjatest Design System

The actual, shipped design system — extracted from the live code, not aspiration. Source of truth for tokens is `app/globals.css` (`@theme inline`, lines 7–32); this document explains how those tokens are used in practice.

> History: this file previously held a captured analysis of MongoDB's website (deep teal `#001e2b`, brand green `#00ed64`, Euclid Circular A) used as inspiration during the initial build. The shipped UI diverged on every axis — different accent, different background, different font — so that analysis was retired. If you see MongoDB hex values in old commits or the product spec, they are historical.

---

## 1. Identity

**Feel:** competitive, terminal-adjacent, nocturnal. A quiz-battle arena that reads like a developer tool, not an ed-tech site. Monospace everywhere, near-black surfaces, one saturated mint-green accent doing all the CTA work, gold reserved for ratings and prestige.

- **Dark mode is the product.** The `.dark` block in `globals.css` is the real theme; the `:root` light block exists as a fallback and is not designed against.
- **Geist × Geist Pixel is the brand pairing.** `--font-sans` resolves to Geist (proportional, body default); `.font-pixel` (Geist Pixel Square) is the display face for headings/wordmark contexts; `--font-mono` stays Geist Mono for explicit `font-mono` accents (ranks, timers, micro-labels). All loaded in `app/layout.tsx` via `next/font`.
- **One accent rules.** Brand mint `#06d6a0` is the only color allowed on primary actions. Gold, pink, ocean, and lavender are informational, never competing CTAs.

## 2. Color

### Core palette (dark theme, the default)

| Token | Hex | Role |
|---|---|---|
| Background | `#120F17` | Page background — near-black with a violet cast. **Not** teal. |
| Surface / card | `#111111` | Cards, popovers, inputs (`--color-teal-surface`) |
| Elevated | `#1c1c1c` | Hover states, nested surfaces (`--color-teal-elevated`) |
| Hairline | `#222222` | Default borders (`--border`) |
| Hairline strong | `#333333` | Emphasized borders, input outlines |
| Ink | `#ffffff` | Primary text |
| Text secondary | `#c5e8f0` | Secondary copy (pale cyan) |
| Text muted | `#7ab5cc` | Labels, metadata — the workhorse muted tone |
| Text disabled | `#4a8fa8` | Disabled/tertiary |

### Accents

| Token | Hex | Role |
|---|---|---|
| Brand primary | `#06d6a0` | CTAs, links, positive deltas, "online" indicators, QUANT section |
| Brand primary dark | `#05b088` | Pressed/hover state of primary |
| On-primary | `#073b4c` | Text/icons placed on brand-primary fills (deep teal, legacy of the original palette — reads near-black on mint) |
| Gold | `#ffd166` | ELO ratings, trophies, streaks, DILR section |
| Pink | `#ef476f` | Losses, errors, destructive, negative deltas |
| Ocean | `#118ab2` | VARC section, secondary informational |
| Lavender | `#9f84bd` | **Landing page only** (`app/landing-client.tsx`) — decorative accent in hero/FX, never in the app shell |

`#073b4c` (teal-deep) and `#1c2d38` survive as occasional deep-tinted fills but are legacy; new surfaces should use `#111111`/`#1c1c1c`.

### Semantic mapping

- Win / positive / correct → mint `#06d6a0`
- Loss / negative / wrong → pink `#ef476f`
- Rating / prestige → gold `#ffd166`
- Draw / neutral → muted `#7ab5cc`

### Section colors (fixed, used in badges and charts)

From `getSectionBadgeClass` in `lib/utils.ts`:

- **VARC** → ocean: `bg-[#118ab2]/20 text-[#c5e8f0] border-[#118ab2]/40`
- **DILR** → gold: `bg-[#ffd166]/20 text-[#ffd166] border-[#ffd166]/40`
- **QUANT** → mint: `bg-[#06d6a0]/20 text-[#06d6a0] border-[#06d6a0]/30`

### League tiers (computed from ELO, `lib/leagues.ts`)

Diamond `#06d6a0` (≥2100) · Platinum `#c5e8f0` (≥1800) · Gold `#ffd166` (≥1500) · Silver `#7ab5cc` (≥1200) · Bronze `#4a8fa8`. League badges tint via inline style with hex-alpha suffixes: text at full color, border at `4d` (~30%), background at `1a` (~10%).

### Charts

`--chart-1..5` = mint, gold, ocean, pink, teal-deep. `components/elo-graph.tsx` (Recharts) draws the ELO line in mint on the card surface.

## 3. Typography

Pairing: **Geist** (body, everything by default) + **Geist Pixel Square** (`.font-pixel` display headings) + **Geist Mono** (explicit `font-mono` accents only).

Observed scale (usage-frequency order — this is a small-type UI):

| Class | Usage |
|---|---|
| `text-sm` (14px) | Body default — the most common size |
| `text-xs` (12px) | Metadata, labels, badge text — close second |
| `text-base`–`text-xl` | Card titles, emphasized stats |
| `text-2xl` | Big numbers (ELO, scores) — usually `font-bold`, often gold |
| `text-3xl`/`text-4xl` | Landing hero, result verdicts only |

Weights: `font-semibold` for titles/names, `font-bold` for numbers and emphasis, `font-medium` for interactive labels, `font-black` reserved for hero/verdict moments. Headers use `tracking-tight`; uppercase micro-labels use `uppercase` + `tracking-wider`/`tracking-widest` + `text-xs text-[#7ab5cc]`.

## 4. Shape, space, layout

- **Radius:** `--radius: 0.75rem`. In practice: `rounded-xl` for cards, `rounded-lg` for inner elements/buttons, `rounded-full` for pills, avatars, dots, and status chips (the single most-used radius). `rounded-md` is rare.
- **Layout:** single centered column, `max-w-2xl mx-auto px-4` for app screens; header is a `border-b border-[#222222]` bar with logo left, avatar/actions right. Landing page uses wider containers.
- **Card idiom:** `bg-[#111111] rounded-xl p-5` (sometimes `p-4`/`p-6`), optional `border border-[#222222]`. Nesting goes surface → elevated (`#1c1c1c`), never shadows — elevation is expressed by lightness, not shadow.
- **Status pill idiom:** tinted translucent chip — `bg-{accent}/10 border border-{accent}/20 rounded-full px-2.5 py-1` with a 1.5px dot and `text-xs font-medium` in the accent color (see the "N online" pill in `app/lobby/lobby-client.tsx`).
- **Spacing:** `space-y-6` between page sections, `gap-2`/`gap-3` inside rows, `gap-4` between card regions.

## 5. Components

- **shadcn/ui primitives** (style `base-nova`, `components.json`): avatar, badge, button, dialog, dropdown-menu, input, label, sonner (toasts). Mapped onto tokens via the `--color-*` shadcn variables in `globals.css`.
- **Custom components** (`components/`): `ninja-logo` (mark in a mint circle, `on-primary` glyph), `countdown-ring` (per-question timer), `speed-meter`, `elo-graph` (Recharts), `challenge-dialog`, `google-signin-button`, `error-boundary`.
- **Icons:** Lucide, typically `size={16}` inline and 12–20px in chips. Icon color follows text color.
- **Toasts:** sonner, top-level, terse messages.
- **Landing FX** (landing page only, never in-app): `components/Aurora.tsx` (ogl WebGL aurora), `Grainient.jsx` (`@antoineview/grainient` gradient noise), marquee ticker, airport-board `examFlip` animation.

## 6. Styling conventions (how code is actually written)

- **Raw hex arbitrary values, not token classes.** The codebase overwhelmingly writes `text-[#7ab5cc]`, `bg-[#120F17]`, `border-[#06d6a0]/20` rather than `text-text-muted` etc. The `@theme` tokens exist and back the shadcn variables, but hand-written component code uses literal hex. Match this idiom when editing existing screens; don't "fix" it mid-file.
- **Alpha via Tailwind slash opacity** (`/10`, `/20`, `/40`) for tints; via hex suffix (`1a`, `4d`) only in inline `style` objects (league badges).
- **`cn()` from `lib/utils.ts`** (clsx + tailwind-merge) for conditional classes.
- **Dark-only styling** — components style against the dark palette directly; no `dark:` prefixes in app code.

## 7. Motion

All keyframes live in `globals.css`, all gated behind `prefers-reduced-motion: reduce`:

- `elo-pop` — ELO delta pop-in on results (0.4s, expo-out)
- `queueBounce` / `pulse-dot` — matchmaking search dots
- `marquee` — landing ticker (32s linear loop)
- `examFlip` — landing airport-board exam-name shutter
- `animate-pulse` (Tailwind built-in) for live dots

Motion is sparse and purposeful: feedback moments (ELO delta, queue searching) and landing flourish. No page transitions, no scroll animation in-app.

## 8. Rules of thumb

1. New app surfaces: `#120F17` page, `#111111` card, `#222222` hairline, white/`#7ab5cc` text, mint for the one action that matters.
2. Never introduce a second CTA color. Gold is for numbers, not buttons.
3. Numbers are the heroes — big, bold, colored (gold ELO, mint/pink deltas); labels around them are `text-xs` muted.
4. Every animation gets a `prefers-reduced-motion` fallback.
5. Section colors (VARC/DILR/QUANT) and league colors are fixed vocabularies — reuse `getSectionBadgeClass` and `getLeague`, never restate the hexes.
6. Landing page may use lavender `#9f84bd` and WebGL FX; app screens may not.
