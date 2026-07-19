# Technical Co-Founder — Ninjatest

## About Ninjatest

Ninjatest is a real-time, competitive prep platform for the world's toughest competitive exams — exams where millions compete for a few thousand seats, like India's CAT, JEE, and UPSC, or global gatekeepers like the GMAT, GRE, and LSAT. Preparation for these exams is a multi-year, high-stakes grind — and today it's done alone, against static mock tests that feel nothing like the pressure of the real thing.

We're changing that. Think chess.com, but for exam prep: two aspirants face off in live 1v1 battles with ELO ratings, leagues, seasons, win streaks, and leaderboards. Scoring is fully server-authoritative, matches run on self-paced per-player clocks, and every question adapts to your rating — the bank itself learns difficulty from real play. We're launching with the CAT (Common Admission Test) — 9-question battles across VARC, DILR, and Quant — and expanding exam by exam.

**AI is not a feature bolted on — it's half the product.** Every player gets "Ninja," an AI coach woven through the entire experience:

- **Post-match debriefs** that analyze exactly where a match was won or lost, question by question.
- **An agentic coach** that reasons over your full performance history — accuracy by section, question type, and difficulty band, rating trends, recent mistakes — and answers open questions grounded in your actual data, not generic advice.
- **A Socratic study buddy** that gives hints, not answers, so practice builds skill instead of dependence.
- **Personalized 7-day study plans** regenerated weekly from your weakest areas.
- **PDF solving** — upload any mock test or question paper and get worked solutions.
- **Daily focus nudges** that turn your recent play into one concrete thing to fix today.

Under the hood: an agentic tool-calling coach, semantic search over the question bank via embeddings, per-question attempt ceilings and cost caches so every LLM call is guarded, and strict anti-cheat gating — no AI access while a live match is running.

## Where we are

The MVP is fully built and hardened — not a prototype:

- All core screens shipped: matchmaking, live battles, spectate mode, profiles, leaderboards, friend challenges, practice drills, and an admin question console.
- A question bank of 3,000+ real CAT questions (MCQ + TITA) with adaptive, ELO-driven question selection and semantic embeddings.
- The AI layer is live: match debriefs, an agentic coach, daily focus, and study plans — cost-guarded and rate-limited end to end.
- Multiple rounds of security and performance hardening are done (RLS, rate limiting, anti-cheat telemetry, server-side timing).
- We are currently in **pre-launch waitlist mode**, collecting signups on the landing page. Launch is one config flip away.

## The role

We're looking for a **technical co-founder** to own the product and take it from launch through scale.

### What you'll own

- **The entire product lifecycle, end to end** — engineering, shipping, infrastructure, product decisions, and quality — until we hire our first engineering team. You are the engineering org on day one.
- Launch, iteration speed, and everything users touch.

### Must-haves

- **Deep experience with agentic software development.** You build with AI agents as a core part of your workflow (Claude Code or equivalent), and you know how to direct, verify, and ship agent-produced code at production quality. This is how the product was built and how it will continue to be built.
- Strong command of our stack, or the ability to get there fast:
  - **Frontend:** Next.js (App Router, RSC), React 19, TypeScript, Tailwind CSS, shadcn/ui
  - **Backend:** Supabase — Postgres, Auth, RLS, Realtime, server-authoritative RPCs (PL/pgSQL), pg_cron, pgvector
  - **AI:** LLM integration via OpenRouter (Vercel AI SDK), agentic coach flows, semantic search with pgvector embeddings, cost and rate-limit engineering
  - **Infra:** Vercel (multi-project deployments), Docker, Kubernetes, Resend
- **Sole focus.** This is a full-time, exclusive commitment. No side projects, no consulting, no other startups.
- **Comfortable and fluent on camera.** You'll represent the product publicly — demos, content, investor calls, community. Being articulate on video is part of the job, not a nice-to-have.
- **Active participation in fundraising.** You'll be in the room for investor conversations — building the technical narrative, fielding diligence, and pitching alongside the founding team.

### Compensation

- **Equity, vested annually.** Founder equity on a yearly vesting schedule. Details discussed with serious candidates.

## How to apply

Reach out with:

1. What you've shipped — links, not descriptions.
2. How you use AI agents in your development workflow, concretely.
3. Why competitive test prep, and why now.
