# PROMPT — Ninjatest Landing Page Redesign ("19th.com treatment")

> Feed this prompt to the implementing agent/designer as-is. It encodes a full teardown of
> https://www.19th.com/ (markup, shaders, scroll systems, and micro-interactions were
> extracted from the live Astro bundle on 2026-07-15) mapped onto the Ninjatest brand.

---

## Role

You are a senior motion-web designer/engineer — the kind who ships $10,000 marketing sites
with canvas shaders, scroll choreography, and obsessive micro-interaction polish. You are
rebuilding the Ninjatest landing page (`app/landing-client.tsx`, Next.js 16 + React 19 +
Tailwind v4) so it **feels and moves exactly like 19th.com**, but wears only the Ninjatest
brand. You write production code: 60fps, `prefers-reduced-motion` fallbacks on every
animation, mobile breakpoints, no new heavy dependencies (the repo already has `ogl`;
canvas 2D and CSS do the rest).

## Hard constraints (do not violate)

1. **Right-side mint Play rail stays exactly as-is.** The existing collapsing
   `20vw → 100vw` `#06d6a0` panel with the vertical "PLAY/WAITLIST" label, the dark
   triangle, and the expanding waitlist survey flow is untouched. You redesign **only the
   left scroll column**.
2. **Hero exam flip stays.** The airport-board `FlipWord` cycling
   `CAT / XAT / GMAT / SSC / Bank / JEE / NEET` in mint remains the first word of the
   headline. **Every other word in the headline is static** — no rotating verbs, no
   sliding lines around it. One moving word, everything else planted.
3. **A marquee remains** (the existing `animate-marquee` ticker idiom, 32s linear loop),
   placed directly under the hero as the seam into the page body.
4. **Ninjatest brand colors only** — from `DESIGN.md`. No 19th red `#ff0010`, no purple
   scale. Palette:
   - Background `#120F17` · Card `#111111` · Elevated `#1c1c1c` · Hairline `#222222` / `#333333`
   - Ink `#ffffff` · Secondary `#c5e8f0` · Muted `#7ab5cc` · Disabled `#4a8fa8`
   - **Mint `#06d6a0` = the only CTA color** (on-mint text `#073b4c`/`#120F17`)
   - Gold `#ffd166` (ratings/DILR) · Pink `#ef476f` (losses) · Ocean `#118ab2` (VARC)
   - Lavender `#9f84bd` — landing-only decorative accent
   - Section vocabulary is fixed: VARC=ocean, DILR=gold, QUANT=mint.
5. **Typography: Geist Pixel for all landing display text.** Load Geist Pixel via
   `next/font` (local `.woff2` under `app/fonts/` if not in the `geist` package version
   installed) and use it for every headline, section title, big number, eyebrow, and pill
   label on the landing page. Body/paragraph copy stays Geist Mono. Do not touch in-app
   fonts.
6. **Tone: professional yet playful, written for serious students** (CAT/XAT/GMAT
   aspirants). Kill all GenZ slang — no "hits different", "cooked", "vibes", "big brain
   energy", "the grind". Playfulness comes from precision and wit, not slang. Full
   replacement copy is provided below; use it.
7. Every animation gated behind `@media (prefers-reduced-motion: reduce)` with a static
   fallback. Canvas effects pause when offscreen (IntersectionObserver) and on
   `document.hidden`.

---

## The reference, decoded — what 19th.com actually does

Recreate each of these systems 1:1 in behavior (re-skinned to Ninjatest):

### R1. Thermal boundary shader (the signature)
A full-width `<canvas>` strip (~256px tall) rendering a **heat-diffusion field**: a
simplex-noise-driven boundary line between "solid color" and background, simulated on a
low-res grid (diffusion + cooling each frame), mapped through a 256-entry color LUT built
from the solid color's HSL (dark → saturated → hot/near-white). The **cursor is a heat
brush** — moving over it injects heat that blooms and cools; a damping selector reduces
cursor heat near the signup form so the effect never fights the CTA. All parameters are
CSS custom properties (`--thermal-resolution`, `--thermal-diffusion`, `--thermal-cooling`,
`--thermal-noise-amp/speed/scale`, `--thermal-bnd-center/width`, `--thermal-brush-radius`,
`--thermal-heat-intensity`, …) so it's art-directable per instance. It appears **twice**:
flipped at the hero's bottom edge, and upright above the footer.
**Ninjatest skin:** `--thermal-solid: #06d6a0` — a mint heat-field. LUT ramps
`#120F17 → deep teal → #06d6a0 → #c5e8f0` (never white-hot pink/red). Reduced-motion
fallback: static mint gradient band with a soft noise texture.

### R2. Hero
Sticky minimal header (logo only, mix-blend against page). Badge pill above the headline
with a small icon **spinning at 18s linear infinite** (19th uses a smiley; use the Ninja
logo mark). Two-line static headline, supporting paragraph with a bold second clause,
inline email signup whose success state fires a **spring pulse**
(`0.52s cubic-bezier(.34,1.56,.64,1)`) — reuse that exact spring for the waitlist
button/online-count pill feedback. Thermal strip bleeds from the hero's lower edge.

### R3. Infinite scroll-snap carousel ("Built on 19th")
Three-segment title, each segment a different tint (primary white / secondary muted /
tertiary faint), subtitle, chevron prev/next controls. Track = 7 unique cards **tripled**
(21 nodes) with `scroll-snap-type: x mandatory`, `scroll-snap-align: start`, teleport-loop
when crossing the clone boundary, draggable + keyboard accessible. Each card: eyebrow
category, title, one-line body, and a `meta-label / meta-value` footer ("Built from —
14,000 structured sequences"), with a per-card accent CSS variable.

### R4. Interactive performance section
Header with **pill toggle buttons** ("Accuracy vs Cost" / "Accuracy vs Speed") that
re-lay-out a scatter plot of labeled data points; label placement runs a collision-
avoidance pass (tries 8 anchor positions per point). Below: three stat cards, each
`label → huge highlight ("160× faster") → value → footnote comparison`. Section uses
`scroll-margin-top` for anchored nav.

### R5. Floating-pill parallax scene ("use cases")
A tall section with a `position: sticky` inner scene. 15 feature pills are absolutely
placed via `--pill-left` / `--pill-top` (positions from 52% to 154% — i.e. staged below
the fold) and each carries its own `--pill-speed` (0.68–0.92). On scroll, pills **drift
upward through the sticky scene at different rates** — genuine multi-plane parallax.
Center stage: one sentence with a **single rotating word**
("…models that *extract / classify / score / rank / transform*").
**Ninjatest adaptation:** the rotating-word slot is already spent on the hero's exam flip
(constraint #2), so here the sentence stays fully static and the parallax pills carry all
motion.

### R6. Canvas particle flow ("Search → Distill → Ship")
A 2D-canvas simulation: ~240 particles advected through an fbm-noise flow field with
fading trails, colored by a heat colormap, converging left→right toward a goal — the
visual metaphor for "many candidates distilled into one". Three step cards beneath
(title + one line each). Honors reduced-motion and swaps to a simpler render on
`max-width: 767px`.
**Ninjatest skin:** particles in muted ocean/lavender converging into a single mint
trail — "a thousand aspirants, one rating that's honest".

### R7. Big CTA footer
Full-bleed closing section: one big headline, one line of body, the same email/CTA
pattern as the hero, thermal strip, then a spare link footer (Company / Legal / Connect).

### R8. Global grammar
- 12-col grid with `--grid-margin` / `--grid-gutter` custom properties; generous
  `padding-block` rhythm (~1 column-width between sections).
- Hairline section seams, panels with per-panel accent variables.
- No scroll-hijack, no GSAP — everything is scroll-snap, sticky, rAF canvases, CSS
  keyframes, and IntersectionObserver reveals. Keep it that way.
- Subtle entrance reveals: translate-y 12–20px + fade, 0.5–0.7s expo-out, staggered
  80–120ms within a group, triggered once at ~30% visibility.

---

## Page architecture (build these sections, in order)

### S1 — Hero (left column redesign)
- Keep: `FlipWord` exam cycler (mint), right Play rail, online-count pill.
- New headline (Geist Pixel, `clamp(3.2rem, 6.5vw, 6rem)`, static except FlipWord):
  **"[CAT] prep is a solo sport. Not anymore."**
- Sub: "Nine questions. Three sections. One opponent. Real-time 1v1 mock battles with a
  rating that tells you the truth about where you stand."
- Badge pill above headline: spinning Ninja mark (18s linear) + "Now rating aspirants
  across India".
- Feature micro-row under CTA: `9 questions · VARC / DILR / QUANT · ELO rated · matches
  under 10 minutes` in muted mono.
- Mint **thermal boundary strip (R1, flipped)** at the hero's bottom edge, cursor-reactive,
  damped near the CTA cluster.

### S2 — Marquee (kept, re-skinned)
Existing 32s ticker idiom, new content: alternating exam names, section badges in their
fixed colors, and live-feeling stats ("2,400 ELO ceiling", "90s per VARC question",
"zero-sum ratings") separated by mint dots. Pauses on hover.

### S3 — "A match, in nine questions" — infinite carousel (R3)
Three-tint Geist Pixel title: **"One opponent." / "Nine questions." / "No hiding."**
Sub: "Every battle is a compressed mock: three VARC, three DILR, three Quant — or nine
from the section you fear most."
Seven cards (tripled for the infinite loop), each with section-colored accent, eyebrow,
title, body, and a `meta` footer in the 19th "Built from" idiom:
1. **VARC** (ocean) — "Reading, against the clock" — passage-grouped questions with a
   60s reading window before the timer bites. *Timed at — 90s per question*
2. **DILR** (gold) — "Sets that fight back" — puzzle sets served as a group, hardest
   section, longest clock. *Timed at — 120s per question*
3. **QUANT** (mint) — "Speed is a skill" — highest speed multiplier; fast correct answers
   out-score slow correct answers. *Timed at — 105s per question*
4. **Server-scored** (lavender) — "The referee is a database" — answers scored
   server-side; client clocks and client claims are ignored. *Measured — server time only*
5. **Speed bonus** (mint) — "Every 5 seconds saved counts" — bonus accrues in 5s blocks;
   a random guess is worth exactly zero expected points. *Max — 140 points/question*
6. **Live opponent** (ocean) — "You see them answer" — real-time presence: know when your
   opponent locks in, never what they chose. *Latency — under a second*
7. **Spectate** (gold) — "Watch the top table" — any live match is watchable, read-only,
   with scores hidden until reveal. *Delay — none*

### S4 — AI section (dedicated) — "A coach that watched every move"
This is one of the two centerpiece sections. Layout: alternating text + **real product
screenshots** (see Screenshot manifest). Anchor id `#ai`.
- Title (Geist Pixel): **"After the battle, the debrief."**
- Eyebrow: "Ninja — the AI layer"
- Body: "Ninja reviews your match the way a good teacher would: where you lost time,
  which trap you took, what to drill next. Then it builds the practice set itself."
- Four feature blocks, each with an eyebrow pill + screenshot:
  1. **Match debrief** — per-question breakdown of your time, your opponent's time, and
     the swing moments. *(screenshot: debrief view with a Ninja response)*
  2. **Ask Ninja** — question-level explanations on demand — locked during live matches,
     open the second you finish. *(screenshot: Ninja chat response card)*
  3. **Generated practice** — weakness-targeted sets composed from your own match
     history. *(screenshot: practice screen)*
  4. **A worthy bot** — no opponent online? The bot plays at your rating, honestly — it
     doesn't peek at answers. *(screenshot: match vs bot)*
- Screenshots float with a **two-plane parallax**: image plane at 0.06, its mint glow
  shadow at 0.10 — the 19th depth trick with Ninjatest light.

### S5 — Matchmaking section (dedicated) — the interactive one (R4)
Anchor id `#matchmaking`. Title: **"Matched by the math, in seconds."**
Sub: "Tap play. The queue pairs you with someone at your level — the band widens the
longer you wait, so you always get a game."
- **Pill toggle** (mint active state): "By rating gap" / "By wait time". Toggling
  re-lays-out a scatter/step visualization: rating band (ELO ±100 growing to ±1000) vs
  seconds waited, with labeled dots for "You", "Opponent pool", "Matched". Labels run
  collision avoidance. Data is illustrative but derived from the real rules
  (band = `min(1000, 100 + wait_s × 20)`).
- Three stat cards (19th idiom — label / big highlight / value / footnote):
  - "Time to match" / **"under 10s"** / "typical at peak" / "band widens 20 ELO per second"
  - "Rated fairness" / **"zero-sum"** / "every point won is a point lost" / "100 ELO floor,
    no farming"
  - "Rematch guard" / **"3 per day"** / "same rated pair" / "so ratings stay honest"
- Feature pills row (static, tinted chips): `ELO-banded queue` `heartbeat liveness`
  `forfeit protection` `friend challenges` `section-only battles` `seasonal soft resets`

### S6 — Floating-pill parallax scene (R5) — "Everything the arena tracks"
Tall sticky scene. Center sentence (static, Geist Pixel):
**"One rating. Every habit it exposes."**
15 parallax pills drifting up at individual speeds (0.68–0.92), each a real product
fact, tinted by domain: `reading speed` `set selection` `guess discipline`
`time-per-question` `accuracy under pressure` `win streaks` `peak rating`
`section splits` `head-to-head history` `league placement` `daily tasks`
`season rank` `speed bonus rate` `comeback record` `first-60s decisions`.
Pill idiom: `bg-{accent}/10 border-{accent}/20 rounded-full`, dot + Geist Pixel label.

### S7 — Particle flow (R6) — "Queue. Battle. Rank."
Canvas: ocean/lavender particle streams converging into one mint trail.
Three step cards:
- **Queue** — "One tap. The server finds your equal."
- **Battle** — "Nine synchronized questions. Same clock, same order, no pauses."
- **Rank** — "Margin-weighted, zero-sum ELO. Beat a stronger player, gain more."

### S8 — Closing CTA + footer (R7)
Title: **"Your percentile has an opponent."** Body: "Join the waitlist — early aspirants
get founding badges and first access to rated seasons." CTA defers to the right Play rail
(button opens the same flow). Mint thermal strip (R1, upright). Footer: logo, Privacy,
Terms, Leaderboard — the current spare footer, restyled with hairline seams.

---

## Screenshot manifest (produce these before building)

Run the app locally (`NEXT_PUBLIC_APP_MODE` unset, `npm run dev`), capture at 2× DPR,
1440px viewport, dark theme, then frame each in `#111111` cards with `#222222` hairline
and `rounded-xl`; store under `public/landing/`:

| File | Capture |
|---|---|
| `lobby.png` | `/lobby` — play card + online pill |
| `match-quant.png` | live match, QUANT question, countdown ring mid-sweep |
| `match-varc.png` | VARC passage question showing reading window |
| `result.png` | `/result/[id]` — verdict + ELO delta pop |
| `elo-graph.png` | profile overview with Recharts ELO line |
| `leaderboard.png` | top-10 slice with league badges |
| `spectate.png` | spectator view of a live match |
| `ninja-debrief.png` | AI debrief response (S4 hero image) |
| `ninja-ask.png` | Ask-Ninja explanation response |
| `practice.png` | generated practice set |

Ninja response screenshots are the illustration layer for S4 — treat them like 19th
treats its model cards: cropped tight, real content, no browser chrome.

---

## Copy rules (full rewrite)

- Audience: students preparing for CAT/XAT/GMAT — treat them as adults with a deadline.
- Voice: confident, precise, lightly witty. Numbers do the flexing, not slang.
- Sentence case everywhere except Geist Pixel display lines, which may be sentence case
  too — no ALL-CAPS shouting outside micro-labels.
- Every claim must map to a real mechanic (scoring, ELO, timers) — this brand's charm is
  that the math is real. When in doubt, state the rule ("a random guess is worth exactly
  zero expected points") instead of an adjective.
- Banned: "hits different", "cooked", "no cap", "vibes", "grind", "big brain",
  "that's gonna sting", emoji in body copy.

---

## Engineering notes

- Single file is fine (`app/landing-client.tsx`) but extract the thermal canvas and the
  particle flow into `components/landing/` — they're the two real systems.
- Thermal + particle canvases: devicePixelRatio-aware, sim grid ≤ 1/4 canvas resolution,
  `requestAnimationFrame` loops that stop when offscreen/hidden.
- Parallax: one scroll listener + rAF, transform-only (`translate3d`), `willChange`
  applied on mount, removed when idle. Reuse the existing `data-parallax` pattern.
- Carousel: native scroll-snap + tripled slides + `scrollTo` teleport on clone
  boundaries; buttons scroll by one card; no carousel library.
- Waitlist wiring, survey flow, `/api/waitlist`, online-count hook: untouched.
- Lighthouse: no CLS from canvases (explicit heights), fonts `display: swap`, hero LCP
  is the headline, not an image.
- Verify with the existing checks: `npm run lint`, `npx tsc --noEmit`, and a manual
  reduced-motion pass (macOS: Settings → Accessibility → Reduce Motion).

## Definition of done

- Side-by-side with 19th.com, the page has the same *kinesthetic* signature: cursor-heat
  strip, infinite snap carousel, toggle-driven chart, sticky pill parallax, converging
  particles — all in Ninjatest mint/gold/ocean/pink on `#120F17`, all type Geist Pixel.
- Right Play rail pixel-identical to today. Hero exam flip identical. Marquee present.
- Zero GenZ slang. Zero non-brand hexes. 60fps scroll on an M1 Air. Reduced-motion users
  get a fully legible static page.
