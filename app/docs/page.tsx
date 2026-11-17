import type { Metadata } from "next";
import Link from "next/link";
import { NinjatestLogo } from "@/components/ninja-logo";
import { Enter } from "@/components/enter";

// In waitlist mode nobody can reach the app, so these CTAs point at the landing
// survey (`/#waitlist` opens it on mount) instead of a signup that grants nothing.
const IS_WAITLIST = process.env.NEXT_PUBLIC_APP_MODE === "waitlist";
const CTA_HREF = IS_WAITLIST ? "/#waitlist" : "/auth/signup";

export const metadata: Metadata = {
  title: "Docs — Ninjatest",
  description:
    "How Ninjatest works under the hood: server-authoritative game logic in Postgres, self-paced realtime matches, dual ELO systems, a content pipeline, and an AI layer that refuses to run while you're playing.",
};

// ponytail: server component. Sticky TOC + #anchors need no JS; <Enter> is the
// only client boundary and takes the doc as RSC children, so none of this prose
// ships as JavaScript.

type TocGroup = { part: string; items: { id: string; label: string }[] };

const TOC: TocGroup[] = [
  {
    part: "The product",
    items: [
      { id: "overview", label: "System overview" },
      { id: "surface", label: "The full surface" },
      { id: "stack", label: "The stack" },
    ],
  },
  {
    part: "Foundations",
    items: [
      { id: "authority", label: "Server authority" },
      { id: "auth", label: "Identity & onboarding" },
    ],
  },
  {
    part: "The game",
    items: [
      { id: "matchmaking", label: "Matchmaking" },
      { id: "bots", label: "Bots & cold start" },
      { id: "challenges", label: "Friend challenges" },
      { id: "engine", label: "Self-paced engine" },
      { id: "scoring", label: "Scoring math" },
      { id: "player-elo", label: "Player ELO" },
      { id: "question-elo", label: "Question ELO" },
      { id: "content-model", label: "Passages & caselets" },
      { id: "practice", label: "Practice mode" },
      { id: "spectate", label: "Spectate mode" },
      { id: "progression", label: "Seasons, leagues, streaks" },
      { id: "social", label: "Friends & social" },
    ],
  },
  {
    part: "Realtime & integrity",
    items: [
      { id: "realtime", label: "Realtime transport" },
      { id: "clock", label: "Clock synchronisation" },
      { id: "anticheat", label: "Anti-cheat" },
    ],
  },
  {
    part: "The AI layer",
    items: [
      { id: "ninja", label: "Ninja AI overview" },
      { id: "gate", label: "The live-match gate" },
      { id: "prompting", label: "Prompt construction" },
      { id: "cost", label: "Cost engineering" },
      { id: "reasoning", label: "Reasoning tokens" },
      { id: "solve", label: "The PDF solver" },
      { id: "embeddings", label: "Vector search" },
    ],
  },
  {
    part: "Data & security",
    items: [
      { id: "data", label: "Data model & RLS" },
      { id: "limits", label: "Rate limiting" },
      { id: "email", label: "The email layer" },
      { id: "headers", label: "HTTP hardening" },
      { id: "migrations", label: "Migration discipline" },
    ],
  },
  {
    part: "Content pipeline",
    items: [
      { id: "ingest", label: "PDF → question bank" },
      { id: "enrichment", label: "Enrichment passes" },
      { id: "bank", label: "The bank today" },
    ],
  },
  {
    part: "Craft & operations",
    items: [
      { id: "design", label: "Design system" },
      { id: "motion", label: "Motion vocabulary" },
      { id: "perf", label: "Performance" },
      { id: "cron", label: "Scheduled jobs" },
      { id: "testing", label: "How it's verified" },
      { id: "deploy", label: "Deployment topology" },
      { id: "limitations", label: "Honest limitations" },
      { id: "numbers", label: "The numbers" },
      { id: "glossary", label: "Glossary" },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <nav className="px-6 sm:px-10 py-5 flex items-center justify-between border-b border-[#1e1a26] sticky top-0 z-30 bg-[#120F17]/95 backdrop-blur">
        <Link href="/">
          <NinjatestLogo />
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/docs/changelog" className="text-white/45 hover:text-white text-sm transition-colors">
            Changelog
          </Link>
          <Link href="/pricing" className="text-white/45 hover:text-white text-sm transition-colors">
            Pricing
          </Link>
          <Link
            href={CTA_HREF}
            className="text-[#06d6a0] hover:text-white text-sm font-semibold transition-colors"
          >
            {IS_WAITLIST ? "Join Waitlist →" : "Sign up →"}
          </Link>
        </div>
      </nav>

      <div className="max-w-[1220px] mx-auto px-6 sm:px-10 grid lg:grid-cols-[230px_minmax(0,1fr)] gap-12 pb-28">
        {/* Sidebar */}
        <aside className="hidden lg:block">
          <div className="sticky top-[4.5rem] py-14 max-h-[calc(100vh-4.5rem)] overflow-y-auto no-scrollbar">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/30 mb-5">
              Contents
            </p>
            {TOC.map((g) => (
              <div key={g.part} className="mb-6">
                <p className="text-[11px] uppercase tracking-wider text-[#06d6a0]/60 font-semibold mb-2.5">
                  {g.part}
                </p>
                <ul className="space-y-2 border-l border-[#222222] pl-3.5">
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <a
                        href={`#${t.id}`}
                        className="text-white/45 hover:text-[#06d6a0] text-[12.5px] leading-snug transition-colors block"
                      >
                        {t.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <main className="py-14 min-w-0">
          {/* ── Hero ── */}
          <Enter>
            <header className="mb-4">
              <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#06d6a0] mb-5">
                Engineering / Complete architecture
              </p>
              <h1 className="font-pixel text-[clamp(2.2rem,4.6vw,3.6rem)] leading-[1.04] text-balance">
                The technology behind{" "}
                <span className="text-[#06d6a0]">Ninjatest</span>
              </h1>
            </header>
            <p className="text-[#c5e8f0]/75 text-lg font-light leading-relaxed max-w-[64ch] mb-5">
              Ninjatest is a real-time, ELO-rated 1v1 competitive-exam arena. Two
              aspirants, nine questions, one rating on the line. That premise
              forces an uncomfortable engineering constraint: <em>nothing</em>{" "}
              the client says about time, correctness, or rating can be believed.
            </p>
            <p className="text-[#c5e8f0]/60 text-base font-light leading-relaxed max-w-[64ch] mb-9">
              What follows is the complete shipped architecture — every
              subsystem, the invariants that hold it together, the maths, the
              bugs that shipped and what they cost, and the reasoning behind each
              trade. No diagrams of systems we intend to build. Only what runs.
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                "Next.js 16 / React 19",
                "104 migrations",
                "95 Postgres functions",
                "3,168 live questions",
                "pgvector",
                "OpenRouter",
              ].map((t) => (
                <span
                  key={t}
                  className="font-mono text-[11px] text-[#7ab5cc] bg-[#7ab5cc]/[0.07] border border-[#7ab5cc]/15 rounded-full px-3 py-1"
                >
                  {t}
                </span>
              ))}
            </div>
          </Enter>

          <PartRule label="Part I — The product" />

          {/* ── 01 Overview ── */}
          <Section id="overview" n="01" title="System overview">
            <P>
              A match is nine questions — three VARC, three DILR, three Quant, or
              nine from a single section in a section-mode challenge. Each player
              traverses their own nine on their own clock. Every answer is scored
              on the server against a clock the server started, and the winner is
              decided only once both players have finished.
            </P>
            <P>
              Architecturally the product is three layers, and the middle one is
              deliberately thick:
            </P>
            <Layers />
            <P>
              The unusual choice is layer two. There is no Node game server, no
              Edge Function tier, no queue worker, no Redis. All game-critical
              logic lives in <Code>security definer</Code> Postgres functions —
              95 of them across 104 migrations. The client can only call an RPC
              and render what comes back.
            </P>
            <Note title="Why the game logic lives in the database">
              A separate game server would need its own consensus with Postgres
              about who answered what and when. Putting the scoring transaction
              and the row it mutates in the same place removes that class of bug
              entirely: matchmaking pairing, answer scoring, and rating transfer
              are each a single atomic transaction with row locks, not a
              distributed handshake. The cost is real and we took it knowingly —
              game logic is written in PL/pgSQL, and migrations are the
              deployment mechanism for gameplay changes. In exchange, there is no
              scenario in which the scoreboard and the database disagree.
            </Note>
          </Section>

          {/* ── 02 Surface ── */}
          <Section id="surface" n="02" title="The full surface">
            <P>
              Every route in the application, and what runs behind it. Rendering
              strategy is chosen per route rather than globally.
            </P>
            <Table
              head={["Route", "What it is", "Rendering"]}
              rows={[
                ["/", "Waitlist landing, or authed redirect into the app", "Static + WebGL gradient"],
                ["/auth/*", "Login, signup, password reset, OAuth callback", "Dynamic"],
                ["/onboarding", "First-run profile completion — a single gate", "Dynamic"],
                ["/exams", "Exam picker; every login funnels through here", "Static shell"],
                ["/lobby", "Home base — rating, streak, dailies, entry points", "Dynamic"],
                ["/queue", "Matchmaking with live band widening and heartbeat", "Dynamic"],
                ["/match/[id]", "The battle itself — the most complex client in the app", "Dynamic"],
                ["/result/[id]", "Verdict, rating delta, per-question reveal", "Dynamic"],
                ["/practice", "Solo unrated drills, 1/3/5 questions, weakest-section-first", "Dynamic"],
                ["/spectate", "Live-match browser", "Dynamic"],
                ["/spectate/[id]", "Read-only viewer of a live match", "Dynamic"],
                ["/profile/[username]", "Overview / history / stats / friends", "ISR, 60s"],
                ["/leaderboard", "Top 100 + season banner", "ISR, 60s"],
                ["/friends", "Search, requests, friend list", "Dynamic"],
                ["/settings", "Display name, password, avatar upload", "Dynamic"],
                ["/c/[code]", "Friend-challenge accept link, 15-minute expiry", "Dynamic"],
                ["/ninja", "The AI coach chat — three modes on one route", "Dynamic"],
                ["/ninja/history", "Archive of every AI output, grouped by match and drill", "Dynamic"],
                ["/ninja/solve", "PDF solver", "Dynamic"],
                ["/plan", "Seven-day AI study plan", "Dynamic"],
                ["/pricing", "Plans", "Static"],
                ["/docs", "This page", "Static"],
              ]}
            />
            <P>
              Six API route handlers back the AI layer, plus the waitlist
              endpoint and two transactional email routes. They sit{" "}
              <em>outside</em> the auth proxy&apos;s matcher entirely — a
              deliberate architectural fact, not an oversight — which makes each
              handler fully responsible for its own authentication, its own
              gating, and its own rate limiting. That responsibility is
              discharged inline in every one of them.
            </P>
          </Section>

          {/* ── 03 Stack ── */}
          <Section id="stack" n="03" title="The stack">
            <Table
              head={["Layer", "Choice", "Why this one"]}
              rows={[
                [
                  "Framework",
                  "Next.js 16 App Router, React 19",
                  "Server Components for public pages, route handlers for AI, a proxy for the auth gate.",
                ],
                [
                  "Database + Auth",
                  "Supabase — Postgres, RLS, GoTrue, Google OAuth",
                  "Row-Level Security is the last line of defence; definer functions are the first.",
                ],
                [
                  "Game logic",
                  "PL/pgSQL security-definer functions",
                  "Scoring and the row it writes share one transaction. No Edge Functions anywhere.",
                ],
                [
                  "Realtime",
                  "Supabase Realtime — Broadcast, Presence, Postgres Changes",
                  "Three primitives at three trust levels. The split is a security boundary.",
                ],
                [
                  "Scheduled work",
                  "pg_cron, three jobs",
                  "Timeout draining, stale-queue sweeps, season rollovers — all inside the database.",
                ],
                [
                  "AI",
                  "OpenRouter, one key, one provider",
                  "Model routing is a database row, so switching models needs no deploy.",
                ],
                [
                  "Vector search",
                  "pgvector, 1536-d, exact cosine",
                  "3,168 questions embedded. Exact scan beats an index at this size, with no recall loss.",
                ],
                [
                  "UI",
                  "Tailwind v4, shadcn/ui, Lucide, sonner",
                  "Dark-only, one accent colour, arbitrary hex values rather than a token indirection.",
                ],
                [
                  "Motion",
                  "GSAP via a single shared vocabulary module",
                  "One identity across every screen; reduced-motion is a first-class early return.",
                ],
                [
                  "Charts",
                  "Recharts",
                  "One chart in the product — the rating curve. Not worth a bespoke renderer.",
                ],
                [
                  "Email",
                  "Resend",
                  "Two transactional routes, both with participant-ownership checks.",
                ],
                [
                  "Landing FX",
                  "WebGL grainient via ogl",
                  "Mounted client-only behind the scroll container, so it never appears in server HTML.",
                ],
                [
                  "Hosting",
                  "Vercel — one repo, two production projects",
                  "The public waitlist and the full app are the same commit, split by one env var.",
                ],
              ]}
            />
          </Section>

          <PartRule label="Part II — Foundations" />

          {/* ── 04 Authority ── */}
          <Section id="authority" n="04" title="The server-authority invariant">
            <P>
              One rule governs the entire codebase:{" "}
              <strong className="text-white">
                never trust the client for scoring, timing, ELO, or matchmaking.
              </strong>{" "}
              It sounds obvious and it is violated by almost every quiz product
              on the internet, usually in the same place — the timer.
            </P>
            <P>
              A naive implementation sends <Code>timeTakenMs</Code> from the
              browser. That single field is the whole exploit: patch it to 400ms
              and every answer earns maximum speed bonus. In Ninjatest the client
              never sends a duration. The server wrote the question&apos;s start
              timestamp when it served the question, and computes elapsed time
              itself at submission:
            </P>
            <Pre>{`taken = clamp(now() − q_started_<player>, 0, cap)`}</Pre>
            <P>
              The same principle removes the answer key from the wire. The
              question-serving function strips <Code>correct_index</Code> and{" "}
              <Code>explanation</Code> before the row ever leaves Postgres, so
              &quot;inspect the network tab&quot; returns exactly what the UI
              shows. The explanation arrives only in the reveal call, after the
              answer is locked — and the reveal function refuses to disclose
              questions the player never actually reached on an abandoned match.
            </P>
            <P>
              Forfeits work the same way. A client claiming &quot;my opponent
              left&quot; proves nothing, so the forfeit function requires a
              server-verifiable absence: the opponent must have missed a full
              question deadline plus a five-second grace with no submitted row,
              or already carry a cron-written timeout marker on the previous
              question. The client retries every ten seconds and the server keeps
              refusing until its own evidence is satisfied. A rated forfeit where
              no skill was demonstrated transfers nothing.
            </P>
            <P>
              The practical consequence is that the client is a renderer. It
              holds no authority over anything that affects a rating, which is
              why the entire UI could be open-sourced tomorrow without changing
              the product&apos;s security posture.
            </P>
          </Section>

          {/* ── 05 Auth ── */}
          <Section id="auth" n="05" title="Identity & onboarding">
            <P>
              Authentication is email/password plus Google OAuth. Both land on
              the same database trigger, which is where the interesting
              engineering is.
            </P>
            <P>
              The trigger that creates a profile row on signup must be{" "}
              <strong className="text-white">
                incapable of failing the auth insert
              </strong>
              . If it throws, the user account is not created and the person sees
              a generic auth error with no path forward. So it slugifies the
              display name into a valid username, appends collision suffixes when
              that username is taken, maps the Google-provided name and avatar
              when present, and defends every one of those steps.
            </P>
            <P>
              It deliberately does <em>not</em> seed the admin flag. Elevation is
              an explicit database operation, never a consequence of signup logic
              — a rule that survived a migration which silently dropped an admin
              seed from a stale copy of this very trigger.
            </P>
            <P>
              The onboarding gate is a single chokepoint in the auth proxy: any
              authenticated user who has not completed onboarding is funnelled to
              the onboarding screen from anywhere. Naively that costs a database
              lookup on every authenticated navigation, which would undo the
              single biggest performance optimisation in the app (see{" "}
              <A href="#perf">Performance</A>). A cookie caches the completed
              state, so the lookup happens at most once per session. The cookie
              is a UX hint only — forging it skips a form, not a permission.
            </P>
            <P>
              The OAuth callback route guards its redirect parameter against
              open-redirect abuse, and authenticated users hitting an auth page
              are bounced through the exam picker rather than deep into the app.
            </P>
          </Section>

          <PartRule label="Part III — The game" />

          {/* ── 06 Matchmaking ── */}
          <Section id="matchmaking" n="06" title="Matchmaking">
            <P>
              Pairing is the classic concurrency trap: two players poll at the
              same millisecond and both match with the same third player. The
              queue avoids it with a single atomic statement using{" "}
              <Code>FOR UPDATE SKIP LOCKED</Code> — a row another transaction is
              already claiming is skipped rather than waited on, so pairing never
              double-books and never deadlocks under load.
            </P>
            <P>The rating band widens with wait time:</P>
            <Pre>{`band   = min(1000, 100 + wait_seconds × 20)      -- per player
match if |elo_a − elo_b| ≤ max(band_a, band_b)  -- the wider of the two`}</Pre>
            <P>
              A fresh entrant sees only ±100 rating. After 45 seconds the window
              is ±1000 and effectively anyone. This trades match quality for
              queue latency along a curve rather than at a threshold, and using
              the <em>wider</em> of the two bands means a long-waiting player can
              reach down to a fresh one rather than both having to agree.
            </P>
            <P>Four guards sit on top of the pairing:</P>
            <List
              items={[
                <>
                  <strong className="text-white">Rated-pair cap.</strong> The same
                  two accounts play at most three <em>rated</em> matches per day.
                  Without it, two friends farm rating off each other
                  indefinitely. Never-rated abandons are excluded from the count,
                  so a disconnect does not burn a slot.
                </>,
                <>
                  <strong className="text-white">Live-match rejection.</strong>{" "}
                  Joining the queue is refused for a caller already inside an
                  active match — the same definition of &quot;live&quot; the AI
                  layer reuses, deliberately shared rather than reimplemented.
                </>,
                <>
                  <strong className="text-white">Exactly-nine guard.</strong> A
                  match is refused unless the frozen question array holds exactly
                  nine ids. If a section is too thin to fill its slots, the picker
                  adaptively rolls those slots into another section rather than
                  shipping a short array — because a short array lets the question
                  index run past the end mid-play and corrupts the match. On a
                  genuine content gap the caller simply stays queued rather than
                  erroring.
                </>,
                <>
                  <strong className="text-white">Heartbeat liveness.</strong> The
                  queued client pings every 20 seconds and is told whether its
                  waiting row still exists; a sweep cancels rows whose heartbeat
                  is more than 90 seconds stale. Leaving the queue returns a
                  boolean, because the leave-versus-match race is real: a{" "}
                  <Code>false</Code> means the server matched you first and the
                  client must route into the match instead of back to the lobby.
                </>,
              ]}
            />
            <Note title="A bug that shipped, and the rule it produced">
              The truncation guard exists because the failure it prevents is
              silent. A match built from seven questions doesn&apos;t throw — it
              plays normally and then reads past the array on question eight. The
              lesson generalised into a rule now applied throughout:{" "}
              <em>
                if an invariant can be asserted at write time, assert it at write
                time
              </em>
              . The same guard was subsequently added to the bot path and the
              challenge path, which built the same array through independent code.
            </Note>
          </Section>

          {/* ── 07 Bots ── */}
          <Section id="bots" n="07" title="Bots & the cold-start problem">
            <P>
              A ranked ladder with nobody on it is unplayable, and a real-time
              product cannot ask its first hundred users to wait for each other.
              Bot matches solve the cold start, and they are the one place where
              the self-paced engine is deliberately <em>not</em> used.
            </P>
            <P>
              Bot matches keep the original lockstep path: one shared question
              index, one shared clock, both sides advancing together. This is
              correct rather than lazy — the bot has no independent clock to run,
              and lockstep is cheaper and simpler for the case where one
              participant is a function call. All three lifecycle functions branch
              on whether a bot is present, and one function exists solely to serve
              that path.
            </P>
            <P>
              The bot&apos;s play derives from the question&apos;s own rating: a
              higher-rated question is one it is more likely to get wrong, and its
              response timing is drawn accordingly. That derivation creates an
              important rule —{" "}
              <strong className="text-white">
                the bot&apos;s answers never nudge question ratings
              </strong>
              . Letting them would be a feedback loop in which the difficulty
              measurement is measuring itself. Only the human&apos;s submission
              counts.
            </P>
            <P>
              Bot matches <em>do</em> feed the question-rating system through the
              human side, which was a deliberate reversal: an earlier version
              gated all rating nudges on the match being rated, and since bot
              matches are unrated, the bank stayed frozen at its seed values
              during exactly the period the cold-start tool was doing all the
              work. You cannot collude with a bot, so the collusion concern that
              motivates the unrated exclusion does not apply.
            </P>
          </Section>

          {/* ── 08 Challenges ── */}
          <Section id="challenges" n="08" title="Friend challenges">
            <P>
              A challenge is a short invite code, generated with a cryptographic
              random source, with a fifteen-minute expiry. Two properties are
              fixed at creation and never read from the client afterward: whether
              the match is rated, and whether it is section-mode (nine questions
              from one section) or the standard mixed three-three-three.
            </P>
            <P>
              Fixing them at creation matters because the accept endpoint and the
              email endpoint both need to know, and a client-supplied{" "}
              <Code>is_rated</Code> at accept time would let the accepting player
              decide the stakes after seeing who they were facing.
            </P>
            <P>
              The challenge path builds its own question array — which is why the
              exactly-nine guard had to be added to it separately. Its mixed
              branch adaptively fills exactly like matchmaking; its section-mode
              branch raises when the chosen section is too thin, because
              &quot;nine DILR questions&quot; has no honest fallback that is still
              nine DILR questions.
            </P>
            <P>
              A logged-out visitor can land on a challenge link even while the
              rest of the app is gated, because the alternative is a broken link
              in someone&apos;s WhatsApp. The page routes them through login with
              a return parameter and back to the challenge.
            </P>
            <Note title="Challenges are not in the realtime publication">
              The host waiting on a challenge cannot subscribe to changes on the
              challenges table, because that table is not part of the realtime
              publication. Rather than widen the publication — which would
              broadcast row changes for a table with invite codes in it — the host
              polls. A four-second poll is also the backstop for the queue, so a
              realtime hiccup degrades into a slightly slower match start rather
              than a stuck screen.
            </Note>
          </Section>

          {/* ── 09 Engine ── */}
          <Section id="engine" n="09" title="The self-paced match engine">
            <P>
              Ninjatest originally ran every match in lockstep: one shared
              question index, both players advancing together, the slower player
              dictating the pace. It was simpler and it was wrong. Reading speed
              is part of what an aspirant is training, and lockstep either
              punishes the fast player with dead waiting time or rushes the
              careful one.
            </P>
            <P>
              The current engine gives each player their own clock and their own
              position. The critical decision was to make position{" "}
              <strong className="text-white">derived, not stored</strong>:
            </P>
            <Pre>{`position(user) = count(match_answers where match_id = m and user_id = u)
                 -- 0..9, and 9 means finished`}</Pre>
            <P>
              There is no per-player index column, so there is nothing that can
              desynchronise from the rows that actually exist. A row written{" "}
              <em>is</em> a question advanced, by construction. Two columns hold
              the per-player question clocks; the serving and scoring functions
              read the <em>caller&apos;s</em> clock and advance only the caller.
              The timeout drain works each player independently against their own
              clock. The match finalises when — and only when — both players hold
              nine answers.
            </P>
            <Note title="The subtle part: readers you forget">
              Redefining what a column means breaks every reader of that column,
              including the ones you weren&apos;t thinking about. The old shared
              index was retained — set to the minimum of the two player positions
              — purely so the spectator functions, which read it, always see an
              in-range question. Two readers were still missed on the first pass
              (the answer-reveal path and the spectator clock) and shipped as
              follow-up fixes within the day. The rule written down afterward:{" "}
              <em>
                grep every reader of a column whose meaning you change, not every
                writer
              </em>
              . Writers are obvious; readers are where the silence lives.
            </Note>
            <P>
              The match client had a matching lesson. Any retry path must
              re-derive the self-paced position from the server rather than
              trusting the index it was holding, and a deterministic submit error
              has to be treated as &quot;the answer already landed&quot; rather
              than a reason to retry forever. Both were real stuck-screen bugs;
              both are now handled by rehydrating from the database, which is the
              same recovery path used for realtime reconnects.
            </P>
          </Section>

          {/* ── 10 Scoring ── */}
          <Section id="scoring" n="10" title="Scoring math">
            <P>
              Scoring is entirely server-side and every dial lives in a config
              table, never in application code. The per-question calculation:
            </P>
            <Pre>{`base    = coalesce(question.duration_ms, section_cap_ms)
cap     = base + reading_ms       -- only the first question of a passage group
taken   = clamp(now() − question_started_at, 0, cap)
bonus   = round(speed_mult × floor(least(cap − taken, base) / 5000))

correct → base_points + bonus
wrong   → −round((base_points + bonus) / (n_options − 1))
skipped → 0`}</Pre>
            <Table
              head={["Section", "Time cap", "Reading window", "Speed multiplier"]}
              rows={[
                ["VARC", "90s", "+60s", "2.22"],
                ["DILR", "120s", "+60s", "1.67"],
                ["Quant", "105s", "—", "1.90"],
              ]}
            />
            <P>
              Those multipliers aren&apos;t aesthetic. They were solved for{" "}
              <strong className="text-white">section parity</strong>: with
              different time caps, a flat multiplier makes one section worth more
              per question than another, and rating would then measure which
              section you drew rather than how well you played. Tuned, every
              section maxes at 140 points per question.
            </P>
            <P>
              The reading window is bonus-free by design. The first question of a
              passage group gets extra time to read the passage, but the bonus is
              computed against the base cap, so the extension is grace rather than
              free points. There is exactly{" "}
              <strong className="text-white">one</strong> function that computes a
              question&apos;s cap, and every function operating in a match context
              calls it — serving, scoring, spectating, timeout draining,
              forfeiting, bot acting, debriefing. Reintroducing an inline cap
              calculation anywhere desynchronises timers, which is why the rule is
              written next to the function.
            </P>

            <SubHead>The wrong-answer penalty is derived, not configured</SubHead>
            <P>
              This is the piece we&apos;re proudest of. The penalty started as a
              config value — a flat −30. On four-option questions that made{" "}
              <em>instant blind guessing</em> worth roughly +9 expected points per
              question. A snap-guess script would have out-scored a careful human.
            </P>
            <P>
              The penalty is now derived from the same speed curve as the reward,
              which makes a random guess exactly EV-neutral at every point in time
              and at any option count:
            </P>
            <Pre>{`E[guess] = p × (base + bonus)  −  (1 − p) × (base + bonus)/(n − 1)      p = 1/n
         = (1/n)(base + bonus)  −  ((n−1)/n)(base + bonus)/(n − 1)
         = 0`}</Pre>
            <P>
              Guessing is worth exactly zero, whenever you do it, regardless of
              how many options the question has. As a bonus, the ratio converges
              on CAT&apos;s own 1:3 marking scheme at the time cap. The retired
              config column is still in the table, unread — deleting it is a
              migration we have not needed.
            </P>
          </Section>

          {/* ── 11 Player ELO ── */}
          <Section id="player-elo" n="11" title="Player ELO">
            <P>
              Ratings use a modified Elo with a margin-of-victory term and a
              favourite correction:
            </P>
            <Pre>{`K        = 40 if games < 30 else 24 if elo < 2000 else 16
E_winner = 1 / (1 + 10^((R_loser − R_winner) / 400))
factor   = 0.3 + 0.7 × min(|score_margin| / FULL, 1)          -- forfeit: 1.0
FULL     = 0.2 × Σ (base + max_bonus) × (1 + 1/(n_opts − 1))  -- ≈ 336
factor  *= 2.2 / (0.001 × (R_winner − R_loser) + 2.2)         -- favourite only
Δ        = max(0, round(K × (1 − E_winner) × factor))
Δ_eff    = max(0, min(Δ, R_loser − 100))                      -- rating floor
winner += Δ_eff ;  loser −= Δ_eff                             -- strictly zero-sum`}</Pre>
            <List
              items={[
                <>
                  <strong className="text-white">Margin matters, but not linearly.</strong>{" "}
                  A 0.3 floor means a narrow win still moves rating; the remaining
                  0.7 scales with how decisive it was, normalised against the
                  match&apos;s own maximum possible margin so section-mode and
                  mixed matches stay comparable. The normaliser mirrors the
                  derived wrong penalty, which is why it lands near 336 in every
                  mode.
                </>,
                <>
                  <strong className="text-white">Favourite-shrink.</strong>{" "}
                  Margin-of-victory systems systematically overrate favourites,
                  because a strong player&apos;s margins are autocorrelated with
                  their strength. We apply the FiveThirtyEight-style correction to
                  favourite wins only; underdog wins are untouched.
                </>,
                <>
                  <strong className="text-white">Strictly zero-sum, with a floor.</strong>{" "}
                  The transfer is one number applied in both directions, clamped
                  so nobody falls below 100. A consequence we accepted
                  deliberately: beating a floored opponent gains nothing, which
                  removes the incentive to hunt them.
                </>,
                <>
                  <strong className="text-white">No forced +1.</strong> An earlier
                  version guaranteed at least one point per win. That is a
                  rating-printing press when you play many far-weaker opponents,
                  so it was removed.
                </>,
                <>
                  <strong className="text-white">Ratings are read at finalisation.</strong>{" "}
                  Both players&apos; current ratings are read under{" "}
                  <em>ordered</em> row locks when the match ends, not snapshotted
                  at match creation, so overlapping matches chain correctly
                  instead of applying to a stale base. Ordered locking is what
                  stops two simultaneous finalisations from deadlocking. The
                  stored &quot;before&quot; values are re-synced at finalisation
                  so the result screen reports the true base.
                </>,
                <>
                  <strong className="text-white">Draws share one K.</strong> The
                  lower of the two K-factors, applied once, clamped to the same
                  floor. Per-player Ks used to mint roughly +11 rating out of thin
                  air on every mismatched draw.
                </>,
              ]}
            />
            <P>
              A calibration query buckets rated matches by rating gap and reports
              predicted-versus-actual win rates with a Brier score. The K values
              and the 0.3/0.7 split are meant to be tuned from that measurement
              once there are a few hundred rated matches, not from taste.
            </P>
          </Section>

          {/* ── 12 Question ELO ── */}
          <Section id="question-elo" n="12" title="Question ELO — adaptive difficulty">
            <P>
              Every question carries its own rating, and it moves. When a player
              answers in a rated or bot match, one atomic UPDATE nudges the
              question&apos;s rating against the outcome:
            </P>
            <Pre>{`result = 1.0                      if wrong
       = 0.35 × (taken_ms / cap)   if correct   -- fast + correct ⇒ question is easy
K      = 32 while times_seen < 20 else 16
clamp  [400, 2800]`}</Pre>
            <P>
              Over roughly twenty serves a question converges on the rating at
              which players get it right about half the time — an empirical
              difficulty measurement rather than an author&apos;s guess. Selection
              then biases toward the players&apos; mean rating with{" "}
              <Code>random() × 300</Code> jitter, so matches are challenging
              without being deterministic, and an already-seen question is
              preferentially avoided.
            </P>
            <P>Three exclusions keep the signal clean:</P>
            <List
              items={[
                <>
                  Answers faster than two seconds are discarded, correct or wrong.
                  They are either a misclick or an automation attempt, and both
                  would corrupt the curve. (The telemetry event stays
                  correct-only; the exclusion is deliberately broader than the
                  signal.)
                </>,
                <>
                  Unrated player-versus-player matches never nudge. An uncapped
                  unrated challenge between two colluding accounts was a direct
                  write channel into the question bank.
                </>,
                <>
                  In bot matches only the human&apos;s answer nudges, for the
                  feedback-loop reason described in <A href="#bots">Bots</A>.
                </>,
              ]}
            />

            <SubHead>The starvation cliff: why selection can&apos;t be rating alone</SubHead>
            <P>
              CAT has two question types: multiple-choice, and TITA — Type In The
              Answer, with no options and therefore no guess floor. Identical
              content is genuinely harder as TITA, so TITA seeds sit 100 rating
              points above the MCQ scale. We sized that offset from the
              nudge&apos;s own steady state rather than guessing:
            </P>
            <Pre>{`E[result] = 1 − 0.8p          (p = probability the player knows it)
gap(p)    = −400 × log10( 0.8p / (1 − 0.8p) )
          = +133 / +70 / +37    at p = 0.25 / 0.50 / 0.75`}</Pre>
            <P>
              The gap widens with difficulty; the live TITA set is mid-to-hard, so
              +100 is the honest middle. It is a better guess, not a measurement —
              the nudge still does the real work over the first twenty serves.
            </P>
            <P>
              Then the offset created a worse problem. With selection driven by
              rating alone, on the live bank — 1,090 MCQ rated 1100–1500 against
              52 TITA rated 1300–1600 — the measured TITA count per Quant block
              was:
            </P>
            <Table
              head={["Player rating", "TITA served per 3-question Quant block"]}
              rows={[
                ["1000", "0.00"],
                ["1200", "0.00"],
                ["1400", "0.21"],
                ["1500", "1.39"],
                ["1600+", "1.58"],
              ]}
            />
            <P>
              A cliff, not a gradient. Below 1400 a player never saw a TITA at all
              — and the failure was self-sealing, because a question that is never
              served is never re-rated and can never migrate out of the dead zone.
              Rating is a one-dimensional signal and question <em>type</em> is a
              second dimension it cannot express.
            </P>
            <P>
              The fix is a hard quota: one of every three Quant slots is reserved
              for TITA, with rating still choosing <em>which</em> TITA. That holds
              ~33% at every level, close to CAT&apos;s own ~36%. DILR&apos;s
              standalone fill mirrors the same quota for the same reason. VARC has
              no TITA, so its pick stays rating-only. The quota lives in exactly
              one function so it cannot drift between the match, challenge, and
              practice paths.
            </P>
            <P>
              The accepted cost is stated plainly: 52 TITA served at one-in-three
              are each drawn roughly seven times as often as a given MCQ, so
              repeats surface within about ten matches. The fix for that is more
              TITA content, not fewer served — reverting the quota would restore a
              0% floor, which is strictly worse.
            </P>
            <Note title="TITA answers are numeric, and the input box is the enforcement">
              We measured what the answer matcher accepts: <Code>1900</Code>,{" "}
              <Code>1,900</Code>, <Code>1900.0</Code>, <Code>01900</Code>,{" "}
              <Code>+1900</Code>, <Code>1.9e3</Code> all match — and{" "}
              <Code>Rs.1900</Code>, <Code>1900m</Code>, <Code>1900 metres</Code>{" "}
              do not. So a player who solved correctly and typed the unit the
              question asked for scored zero. The tempting fix — strip non-numeric
              characters — is dangerous in both directions: stripping turns{" "}
              <Code>Rs.1900</Code> into <Code>.1900</Code>, inventing a wrong
              answer out of a right one, and stripping a minus sign marks{" "}
              <Code>−3</Code> correct against a key of <Code>3</Code>, which marks
              wrong answers <em>right</em>. So the matcher stays strict, a database
              constraint forces every TITA key to be numeric, and the answer box
              refuses the non-numeric keystroke rather than sanitising it
              afterward — which is also what the real CAT interface does. What the
              player sees is always what gets scored. The constraint is the
              load-bearing part: the live TITA rows were written by an ingest
              script through the service role, so validating only in the admin path
              would have left the actual writer unchecked.
            </Note>
          </Section>

          {/* ── 13 Content model ── */}
          <Section id="content-model" n="13" title="Passages, caselets & reading windows">
            <P>
              VARC reading comprehension and DILR caselets are not independent
              questions. Four questions hanging off one 500-word passage must be
              served together, or the player pays the reading cost four times and
              the timing model is a lie.
            </P>
            <P>
              Questions therefore optionally belong to a passage group. When the
              picker chooses a group it takes the whole group — requiring at least
              three active sub-questions and preferring the group whose mean
              rating is nearest the target — and the first question of that group
              in the match receives the section&apos;s reading window on top of
              its cap.
            </P>
            <P>
              Which is exactly why the reading window is bonus-free: extending the
              clock without extending the bonus base means a group&apos;s first
              question is not worth more than its siblings.
            </P>
            <P>
              Group-versus-standalone is chosen by a coin weighted on
              availability, not by always preferring a group. The earlier
              always-prefer rule meant the standalone para-jumble and vocabulary
              bank — 345 active VARC questions — was effectively dead on arrival,
              never served because a passage group always won.
            </P>
            <Note title="DILR arrived atomized">
              The DILR ingest produced one row per question with the caselet text
              copied into each — structurally standalone questions that were
              semantically a group. Served that way, a player got one question of
              a four-question caselet and paid full reading cost for a quarter of
              the value. A regrouping pass reconstructed 168 shared caselets from
              682 atomized rows by longest-common-prefix matching on the caselet
              body, and it is idempotent: it skips rows that already carry a group
              id, so re-running it is safe rather than destructive.
            </Note>
          </Section>

          {/* ── 14 Practice ── */}
          <Section id="practice" n="14" title="Practice mode">
            <P>
              Practice is solo, unrated drilling: one, three, or five questions,
              weakest-section-first. It awards no points and{" "}
              <strong className="text-white">never nudges question ratings</strong>
              , because it is unobserved and unrated — neither a trustworthy
              calibration signal nor a channel worth opening.
            </P>
            <P>
              The serving function returns the question type but <em>never</em>{" "}
              the answer key. That sounds obvious and it is the whole design:
              shipping the key before the answer is locked turns a drill into a
              self-serve answer sheet. The key is revealed only on lock, alongside
              the explanation.
            </P>
            <Note title="Removing a filter is not the same as fixing a gap">
              Practice was MCQ-only, then the type filter was dropped so it could
              serve TITA. It measured <strong className="text-white">zero</strong>{" "}
              TITA across five sessions — because selection was rating-only and
              TITA seeds sit 100 points above the MCQ scale, so at a fresh
              player&apos;s 1000 the MCQs won every slot. Exactly the starvation
              cliff from the match path, in a different function. Practice now
              delegates its Quant slot to the same quota function, which is why
              that quota lives in one place. One extra wrinkle: because practice
              asks for as few as one slot, the &quot;at least one TITA&quot; floor
              had to be scoped to three-or-more slots, or a one-question drill was
              a 100% TITA &quot;Quant slot&quot;.
            </Note>
            <P>
              Scoring branches on type, and a blank or whitespace TITA answer is a{" "}
              <em>skip</em>, not a wrong answer — the same distinction the match
              path makes, because charging a penalty for an empty box would make
              the honest &quot;I don&apos;t know&quot; strictly worse than a wild
              guess.
            </P>
          </Section>

          {/* ── 15 Spectate ── */}
          <Section id="spectate" n="15" title="Spectate mode">
            <P>
              Live matches can be watched. Spectating is a separate function
              surface rather than a permission on the player one, which is the
              only way to be confident an observer cannot see something a player
              shouldn&apos;t.
            </P>
            <List
              items={[
                <>
                  Spectator reads go through dedicated functions that serve the
                  same stripped question payload — no keys, no explanations.
                </>,
                <>
                  Updates arrive on a{" "}
                  <strong className="text-white">broadcast-only</strong> channel
                  carrying an explicit whitelist of safe fields, published by the
                  server rather than by either player.
                </>,
                <>
                  Spectators are deliberately excluded from{" "}
                  <strong className="text-white">presence</strong>. If they were
                  in it, an audience arriving or leaving would perturb the
                  presence-based forfeit logic of the players below — a spectator
                  could influence a rated result by closing a tab.
                </>,
                <>
                  The shared question index that self-paced matches otherwise
                  don&apos;t need is maintained purely so spectator reads always
                  land on an in-range question.
                </>,
              ]}
            />
          </Section>

          {/* ── 16 Progression ── */}
          <Section id="progression" n="16" title="Seasons, leagues, streaks & dailies">
            <P>
              Four progression systems, deliberately built at four different
              levels of the stack according to how much state they actually need.
            </P>
            <Table
              head={["System", "Where it lives", "Why there"]}
              rows={[
                [
                  "Seasons",
                  "Two tables + an hourly cron function",
                  "Needs durable history: standings must be snapshotted before the reset destroys them.",
                ],
                [
                  "Leagues",
                  "Pure computed thresholds in app code — no table",
                  "A league is a function of rating, and rating is already fetched everywhere a badge renders.",
                ],
                [
                  "Streaks",
                  "Two columns on the profile, written inside the rating transaction",
                  "Must be atomic with the result, or a crash mid-finalise desyncs them.",
                ],
                [
                  "Daily tasks",
                  "Derived on read — no table at all",
                  "\"Matches and wins today\" is a query over data that already exists.",
                ],
              ]}
            />
            <P>
              Season rollover applies a soft reset —{" "}
              <Code>elo = 1000 + (elo − 1000) / 2</Code> — after snapshotting the
              standings, and writes a reset marker into the rating history. That
              marker is why the profile graph shows the discontinuity honestly
              instead of rendering it as a catastrophic losing streak, and why the
              AI coach&apos;s trend calculation excludes those rows rather than
              reading a reset as a collapse in form.
            </P>
            <P>
              Streaks increment on a win and update the personal best; losses and
              draws zero them; unrated matches touch nothing. Leagues are five
              thresholds — Bronze, Silver at 1200, Gold at 1500, Platinum at 1800,
              Diamond at 2100 — and adding a table for them would have bought
              nothing but a join.
            </P>
          </Section>

          {/* ── 17 Social ── */}
          <Section id="social" n="17" title="Friends & social">
            <P>
              The friendship table uses an{" "}
              <strong className="text-white">ordered-pair primary key</strong>:
              the two user ids are always stored with the smaller first. That
              single constraint makes a duplicate friendship unrepresentable —
              there is no row shape in which A-befriends-B and B-befriends-A can
              both exist — so the deduplication that would otherwise live in
              application code doesn&apos;t need to exist.
            </P>
            <P>
              The table has Row-Level Security enabled and{" "}
              <strong className="text-white">zero policies</strong>. Nothing can
              read or write it directly; every operation — search, request,
              respond, remove, list — goes through a definer function that applies
              its own rules. Deny-by-default plus an explicit surface is the
              pattern used for every table whose access rules are relational
              rather than row-ownership-shaped.
            </P>
            <P>
              Profiles are world-readable by design, which is what makes the
              public profile and leaderboard pages cacheable. Server-owned columns
              — rating, peak, win/loss/draw counts, streaks, the admin flag — are
              frozen against client updates by a check on the update policy, so
              &quot;world-readable&quot; never leaks into &quot;self-editable&quot;.
            </P>
          </Section>

          <PartRule label="Part IV — Realtime & integrity" />

          {/* ── 18 Realtime ── */}
          <Section id="realtime" n="18" title="Realtime transport">
            <P>
              Three realtime primitives are used, and the split between them is a
              trust boundary rather than a performance choice.
            </P>
            <Table
              head={["Primitive", "Carries", "Trust level"]}
              rows={[
                [
                  "Postgres Changes",
                  "Match state, queue status",
                  "Authoritative — it is the database row.",
                ],
                [
                  "Broadcast",
                  "\"Opponent answered\" liveness; spectator updates",
                  "Untrusted. Never carries a score or a correctness flag.",
                ],
                [
                  "Presence",
                  "Who is in the match; the global online count",
                  "A hint. Presence loss starts a client timer; only the server can forfeit.",
                ],
              ]}
            />
            <P>
              Broadcast never carries game-relevant data. It tells you your
              opponent has moved — not what they scored, not whether they were
              right. If the WebSocket layer were compromised tomorrow, the worst
              available outcome is a false liveness ping.
            </P>
            <P>
              Presence drives match start (both players present triggers an
              idempotent start) and the absence timer, but the server enforces its
              own grace period and its own evidence before any forfeit lands.
            </P>
            <P>
              Because realtime is a transport rather than a source of truth, every
              client rehydrates from the database on reconnect, on channel error,
              and on the browser&apos;s <Code>online</Code> event. A dropped
              message costs a render, never a state divergence. A four-second poll
              backstops the queue and challenge flows for the case where realtime
              doesn&apos;t cover a table at all.
            </P>
            <P>
              The global online counter is keyed by user id so multiple tabs
              dedupe, and it is deliberately <em>not</em> subscribed on the
              landing page — one WebSocket per anonymous visitor is a billing risk
              on the single page most likely to be linked publicly.
            </P>
          </Section>

          {/* ── 19 Clock ── */}
          <Section id="clock" n="19" title="Clock synchronisation">
            <P>
              The client renders a countdown, but it renders it against a{" "}
              <em>measured offset</em> from server time rather than its own clock.
              The offset is sampled at the midpoint of the request, which corrects
              for absolute clock skew and not merely round-trip latency — a laptop
              whose clock is four minutes fast would otherwise render a timer that
              is simply wrong.
            </P>
            <P>
              At zero the client auto-submits a null answer. If it doesn&apos;t —
              tab closed, network gone, script blocked — the cron drain writes the
              skip row instead, against the same server-side clock. The display is
              a convenience; the server&apos;s own timestamp is what scores, and
              the two never need to agree for the result to be correct.
            </P>
          </Section>

          {/* ── 20 Anti-cheat ── */}
          <Section id="anticheat" n="20" title="Anti-cheat">
            <P>
              Rating is only worth defending if it is hard to fake. The defences
              are layered, and each one closes a hole we actually found.
            </P>

            <SubHead>Per-player option shuffling</SubHead>
            <P>
              Two players in the same match see the same question with options in
              different orders, generated by a deterministic, IMMUTABLE
              permutation keyed on match, user, and question index. Nothing is
              stored; it is recomputed identically wherever it is needed. Screen
              sharing therefore doesn&apos;t transfer an answer — &quot;it&apos;s
              C&quot; is meaningless across two players.
            </P>
            <P>
              Three functions must agree on that permutation: the one that serves
              shuffled options, the one that maps a submitted display index back
              to canonical before scoring, and the one that maps the canonical
              correct answer forward to display for the reveal. A migration once
              recreated two of them from a pre-shuffle copy and silently desynced
              scoring — correct answers marked wrong, no error anywhere in the
              logs. A dedicated invariant test now fails if the three ever
              disagree.
            </P>

            <SubHead>Row-level isolation of answers</SubHead>
            <P>
              Answer rows are readable by their <em>owner only</em>. The obvious
              policy — participants of a match can read that match&apos;s answers
              — leaked in a way that took a second look to see: with TITA, the
              typed answer is stored as plaintext, so whoever answered first handed
              the other player the answer while the question was still open. Every
              opponent-facing read (reveal, debrief, spectator view) goes through a
              definer function that applies its own timing rules, so tightening the
              policy cost nothing and closed a live channel.
            </P>

            <SubHead>Behavioural telemetry</SubHead>
            <P>
              Clients may report exactly two events — <Code>tab_hidden</Code> and{" "}
              <Code>window_blur</Code> — from a server-side whitelist,
              rate-limited at forty per ten seconds. The server adds its own signal
              the client can neither see nor suppress: <Code>fast_answer</Code>,
              recorded whenever a correct answer arrives in under two seconds.
              Alone each is noise; correlated across a match they are a legible
              pattern, surfaced through an internal review query rather than an
              automated ban — because the false-positive cost of an automatic ban
              on a study product is a lost user with a legitimate grievance.
            </P>

            <SubHead>The collusion surfaces, and how each is closed</SubHead>
            <Table
              head={["Surface", "Closure"]}
              rows={[
                ["Two accounts trading rated wins", "Three rated matches per pair per day"],
                ["Unrated challenges writing the question bank", "Unrated PvP never nudges question ratings"],
                ["Reading the opponent's live answer", "Answer rows are owner-only at the RLS level"],
                ["Sharing the answer letter", "Per-player deterministic option shuffling"],
                ["Scripted instant guessing", "Derived EV-neutral penalty; sub-2s answers excluded from calibration"],
                ["Faking the clock", "Client never sends a duration; server timestamps both ends"],
                ["Faking an opponent walkout", "Forfeit requires server-side absence evidence"],
                ["Asking the AI mid-match", "Every AI route blocked while the caller is in a live match"],
                ["Mining questions via similarity search", "Search returns ids only, service-role only, no consumer wired"],
              ]}
            />
          </Section>

          <PartRule label="Part V — The AI layer" />

          {/* ── 21 Ninja ── */}
          <Section id="ninja" n="21" title="Ninja AI — overview">
            <P>
              Ninja AI is the coaching layer. Several user-facing capabilities,
              each its own route handler doing its own authentication, its own
              live-match gating, and its own per-user and per-IP rate limiting
              inline.
            </P>
            <Table
              head={["Capability", "What it does", "Cost control"]}
              rows={[
                ["Ask", "Explains a specific question you got wrong, including the distractor logic", "3 attempts per question, checked before spending"],
                ["Coach", "Stat-grounded Q&A about your own performance", "Agentic; bounded tool data, capped step count"],
                ["Buddy", "Socratic mode — hints toward the method, never the answer", "Same route, different mode"],
                ["Plan", "A seven-day study plan from your real weaknesses", "Regeneration capped to once a week, in the database"],
                ["Debrief", "Post-match analysis across all nine questions", "Cached per match, first write wins"],
                ["Daily", "One focus line per day", "Cached, one per day"],
                ["Solve", "Upload a PDF of questions and get worked solutions", "Most expensive action in the product"],
              ]}
            />
            <P>
              Everything Ninja produces is archived and re-readable, grouped by
              match and by practice drill. That archive is not a nicety — it is the
              mechanism by which a repeat read never re-bills.
            </P>
            <P>
              Plan mode is one-shot by contract: the route{" "}
              <em>overrides whatever question arrives</em> with a fixed prompt and
              skips thread history. The UI gives it a single button rather than a
              text box, because a free-text box would silently discard what the
              user typed — an interface promising something the backend
              deliberately ignores.
            </P>
            <Note title="One provider, one key">
              Every model call — chat and embeddings alike — goes through a single
              gateway on a single key. Model routing lives in a one-row database
              table read at request time, so changing models is a database edit
              rather than a deploy. Nothing validates a model id at startup, so the
              standing rule is to check any new id against the gateway&apos;s live
              catalogue first: a previous fallback model was silently delisted
              upstream, which made every fallback attempt a guaranteed throw — a
              safety net that had quietly become a second failure.
            </Note>
          </Section>

          {/* ── 22 Gate ── */}
          <Section id="gate" n="22" title="The live-match gate">
            <P>
              An AI that can solve CAT questions, inside a product where solving
              CAT questions faster than another human is the entire point, is a
              cheating engine unless it is gated. So{" "}
              <strong className="text-white">
                every user-facing AI route is blocked while the caller is in a
                live match
              </strong>
              .
            </P>
            <P>
              The important detail is <em>what the gate keys on</em>. It keys on
              the caller, not on the match the request names. Each per-match guard
              only inspects the match in its own arguments — so mid-match, a
              request pointed at an <em>old, completed</em> match passes those
              guards untouched. Second tab, live match running, an LLM solving
              questions.
            </P>
            <P>
              That is why the two mechanisms are not redundant copies of each
              other. The per-match guards stop you asking about a question you
              haven&apos;t reached; the caller gate stops you asking anything at
              all while you&apos;re playing. Neither can be deleted as a duplicate
              of the other, and the code says so where a future reader will look.
            </P>
            <P>
              The gate <strong className="text-white">fails closed</strong>: if the
              check itself errors, the call is blocked. The widest holes were the
              routes taking arbitrary input — the chat coach (paste the live
              question) and the PDF solver (screenshot it into a document). The
              daily-focus route takes no input and is not a cheat channel at all,
              but it rides the same rule so there is exactly one definition of
              &quot;live&quot; in the codebase — the same one matchmaking uses,
              read through the participants-only policy rather than a new function.
            </P>
          </Section>

          {/* ── 23 Prompting ── */}
          <Section id="prompting" n="23" title="Prompt construction">
            <P>
              Prompts are built server-side from database rows, never assembled
              client-side. The construction branches on question type, and getting
              that branch wrong is subtle enough that it has its own no-network
              self-test.
            </P>
            <P>
              An MCQ has options and a correct index; a TITA has neither, and
              carries a typed answer string instead. A skip is therefore a
              different shape for each: for MCQ it is a null selection, for TITA a
              null answer text. Reading a TITA attempt through the MCQ shape
              reports every TITA as skipped — so a player who typed a wrong answer
              would be coached as though they had given up, which is both wrong and
              demoralising.
            </P>
            <P>
              That exact bug shipped twice. Once on the match path, fixed by making
              the read type-aware. Then again on the practice path, where the
              equivalent field was hardcoded null — true while practice was
              MCQ-only, and a lie the moment a drill could serve TITA.
            </P>
            <SubHead>The practice twins</SubHead>
            <P>
              The practice ask-path mirrors the match one with{" "}
              <strong className="text-white">one guard swapped</strong>, and that
              swap is the whole design. Match asks are gated on <em>reached</em>{" "}
              and participant-only. Practice asks are gated on <em>answered</em>{" "}
              and owner-only.
            </P>
            <P>
              Answered rather than reached, because practice already hands over the
              correct answer and explanation the moment the answer is locked — so
              &quot;you answered it&quot; is precisely the point at which the AI
              adds no leak. Before that point, an ask would mine the question bank
              at 45 questions a day. Same three-attempt pre-spend ceiling, scoped
              per session and question.
            </P>
            <P>
              Both sources write into one archive table with an XOR constraint —
              every row belongs to exactly one of match or practice. That
              constraint is what keeps the pre-spend attempt count a single-table
              read and the history page a single union. Adding a third source means
              extending both, deliberately.
            </P>
          </Section>

          {/* ── 24 Cost ── */}
          <Section id="cost" n="24" title="Cost engineering">
            <P>
              LLM calls are the only unbounded-cost operation in the product, and
              they are treated as a resource to be budgeted rather than a feature
              to be sprinkled.
            </P>
            <Table
              head={["Operation", "Measured cost", "Control"]}
              rows={[
                ["Question explanation", "$0.001 – $0.005", "3 attempts per question, checked before spending"],
                ["Match debrief", "~$0.0014", "Cached per match, first write wins — a re-read never re-bills"],
                ["Daily focus", "~$0.0008", "One per day, cached"],
                ["Coach chat turn", "$0.007 – $0.043", "Agentic; cost is quadratic in turn count"],
                ["Study plan", "~$0.002", "Regeneration capped at once a week, enforced in SQL"],
                ["PDF solve", "$0.06 – $0.31", "Chunked; the most expensive user action in the product"],
              ]}
            />
            <List
              items={[
                <>
                  <strong className="text-white">Attempt ceilings are pre-spend.</strong>{" "}
                  The three-explanations-per-question cap is checked before the
                  model is called, not after. It is the only reason a
                  fifteen-per-minute rate limit on that route is financially safe,
                  and it is documented as load-bearing so nobody removes it as
                  redundant.
                </>,
                <>
                  <strong className="text-white">Caches are cost controls, not conveniences.</strong>{" "}
                  Debriefs, daily focus, and study plans are stored on first write.
                  Re-reading is free forever. They look like a UX feature and are
                  actually the billing model.
                </>,
                <>
                  <strong className="text-white">The coach&apos;s data is bounded in app code.</strong>{" "}
                  The agentic coach replays every prior tool result at each of up
                  to six reasoning steps, so an unbounded rating history costs
                  tokens quadratically in conversation length <em>and</em> linearly
                  in career length — on the most expensive route in the app. The
                  curve handed to the model is capped at 30 points. Measured
                  against the real payload shape: 16,590 → 2,658 tokens per turn at
                  200 matches, and 82,590 → 2,658 at 1,000. Below the cap it is a
                  no-op.
                </>,
                <>
                  <strong className="text-white">The cap is deliberately not in SQL.</strong>{" "}
                  The profile graph legitimately wants the entire curve; the bug
                  was only ever in handing it to a language model. And the trim
                  takes the <em>tail</em>, because taking the head would feed the
                  model a stale trend and silently invert the advice — a rising
                  player read as sliding. A self-test asserts both the cap and the
                  tail-order, because only one of those two is obvious.
                </>,
                <>
                  <strong className="text-white">Learning without per-match inference.</strong>{" "}
                  The coach&apos;s knowledge of a player is a
                  bounded-by-construction aggregate — three sections × two question
                  types × three rating bands, plus one trend object — computed in
                  SQL over recent rated matches. Every match teaches the coach
                  something and no match costs an LLM call. It is bounded by
                  construction <em>because</em> the coach replays it six times per
                  turn; adding a rows array to it would reintroduce exactly the
                  problem the curve cap solves.
                </>,
                <>
                  <strong className="text-white">Tool errors never reach the model.</strong>{" "}
                  Coach tools do not forward raw error text, because Postgres error
                  strings would land in model context and can surface in a
                  user-visible answer.
                </>,
              ]}
            />
          </Section>

          {/* ── 25 Reasoning ── */}
          <Section id="reasoning" n="25" title="Reasoning tokens are a budgeting hazard">
            <P>
              The production model emits reasoning tokens. They bill as completion{" "}
              <em>and</em> consume the output budget{" "}
              <strong className="text-white">before any answer text exists</strong>
              . Measured on real calls:
            </P>
            <Table
              head={["Prompt", "Reasoning tokens", "Total completion", "Result"]}
              rows={[
                ["\"2+2\"", "83", "108", "Answered"],
                ["A real Quant solve", "224", "417", "Answered"],
                ["Same solve, 300-token cap", "≥300", "300", "Content came back null"],
                ["A TITA solve, production cap", "—", "1,210 – 2,562", "Answered"],
              ]}
            />
            <P>
              The null is the dangerous row. It is not an error and not a
              truncation warning — just an empty string where an answer should be.
              So output caps are never sized to the visible answer. A route that
              needs one 140-character line still requests a large budget and
              truncates afterward.
            </P>
            <P>
              The model fallback exists specifically for this failure mode. It is
              not availability insurance — the gateway already load-balances across
              28 upstream providers for the primary model, so upstream outage is
              not what a fallback buys. It only helps if the retry loop treats{" "}
              <em>empty text</em> as a failure rather than a success, which one
              route did not, leaving its fallback as dead code until it was
              measured. The trade is stated honestly: when the fallback fires, the
              answer comes from a different model than the one that was evaluated.
            </P>
            <P>
              Disabling reasoning entirely cuts a solve&apos;s cost by 68% and
              still answers correctly on easy items. It is deliberately{" "}
              <em>not</em> enabled, because that is an unmeasured quality trade on
              hard DILR and Quant — the exact questions people ask about.
            </P>
          </Section>

          {/* ── 26 Solve ── */}
          <Section id="solve" n="26" title="The PDF solver">
            <P>
              A user can upload a PDF of questions and get worked solutions. It is
              the most expensive thing in the product and the design reflects that
              at every step.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">The model is text-only.</strong>{" "}
                  Sending PDF parts transparently invokes the gateway&apos;s OCR
                  shim at $2 per thousand pages — roughly 38% of a solve&apos;s
                  total cost, and the single largest line item in the repository.
                  Escape hatches are documented next to the code that triggers it.
                </>,
                <>
                  <strong className="text-white">Documents are chunked.</strong> A
                  60-page upload becomes about fifteen calls, which bounds per-call
                  output and keeps a single failure from discarding the whole job.
                </>,
                <>
                  <strong className="text-white">It is gated like everything else.</strong>{" "}
                  Blocked mid-match — it was one of the two widest cheat channels,
                  since a screenshot of a live question inside a PDF is still a
                  live question — and rate-limited per user and per IP,
                  fail-closed.
                </>,
                <>
                  <strong className="text-white">It shares its extraction path with content ingest.</strong>{" "}
                  The same structured-extraction module serves both the user-facing
                  solver and the internal question-bank pipeline, so improvements to
                  parsing land on both.
                </>,
              ]}
            />
          </Section>

          {/* ── 27 Embeddings ── */}
          <Section id="embeddings" n="27" title="Vector search over the question bank">
            <P>
              Every question carries a 1536-dimensional embedding, backfilled by a
              single idempotent writer that selects only rows with a null embedding
              — which makes re-running it <em>the</em> repair path rather than a
              risk. One shared function builds the embedding input, and read-time
              query embedding must call it too, or the query vector lands in a
              different space and similarity is quietly garbage rather than loudly
              broken.
            </P>
            <P>
              Staleness is a trigger, not a caller&apos;s responsibility: any real
              change to a question body nulls its embedding, from any writer,
              including writers that don&apos;t exist yet. It is scoped so it never
              fires on the rating and times-seen updates the match hot path
              performs, so the most frequent write in the product pays nothing for
              it.
            </P>
            <Note title="Similarity search is a bank-scraping oracle if you let it">
              The search function returns{" "}
              <strong className="text-white">
                ids and similarity scores only, never question bodies
              </strong>
              , and is granted to the service role alone. Even without bodies, a
              similarity score against caller-supplied text is a &quot;how close is
              my guess?&quot; oracle — enough to reconstruct the bank with patience.
              The design rule written beside it: any future consumer must pass a
              server-derived vector, never caller-supplied text. Worth knowing
              generally — the platform&apos;s default privileges grant execute on
              every new function to authenticated users, so revoking public and
              anonymous alone leaves that standing.
            </Note>

            <SubHead>A 140× storage lesson</SubHead>
            <P>
              pgvector defaults vector columns to EXTERNAL storage, pushing every
              6KB embedding into TOAST — so an exact scan pays a detoast per row.
              Measured at 1,247 rows: 677ms and 7,693 buffers TOASTed, versus 4.8ms
              and 1,372 buffers inline.
            </P>
            <P>Two traps sit in the fix.</P>
            <P>
              First, altering the storage mode only governs rows written{" "}
              <em>after</em> the alter, so the existing bank stays TOASTed and the
              improvement never materialises — the speedup can be claimed for
              months without ever having been real.
            </P>
            <P>
              Second, and genuinely subtle:{" "}
              <Code>update questions set embedding = embedding</Code> is a{" "}
              <strong className="text-white">silent no-op</strong>. Assigning a
              column to itself passes the same TOAST pointer through, Postgres sees
              an unchanged external datum, and never re-toasts it. Forcing a fresh
              datum requires a round trip through the type —{" "}
              <Code>embedding = (embedding::text)::vector(1536)</Code> — verified
              lossless across every row before it was run.
            </P>
            <P>
              There is no approximate index. At this bank size the exact scan is
              fast enough and has no recall loss; an HNSW index would be complexity
              bought with accuracy for a latency win nobody would feel.
            </P>
          </Section>

          <PartRule label="Part VI — Data & security" />

          {/* ── 28 Data ── */}
          <Section id="data" n="28" title="Data model & Row-Level Security">
            <P>
              RLS is enabled on every table. The interesting policies are the
              restrictive ones:
            </P>
            <Table
              head={["Table", "Policy", "Reasoning"]}
              rows={[
                [
                  "questions / passages",
                  "using (false) — no client read, ever",
                  "The bank is the product. Served only through definer functions that strip keys.",
                ],
                [
                  "match_answers",
                  "Own rows only",
                  "Participant-scope leaked the opponent's live TITA answer text.",
                ],
                [
                  "matches",
                  "Participants only",
                  "Every opponent-facing read goes through a definer function with its own timing rules.",
                ],
                [
                  "profiles",
                  "World-readable; server-owned columns frozen from client UPDATE",
                  "Public profiles are a feature; self-set rating is not.",
                ],
                [
                  "rating_history",
                  "Own rows",
                  "Read for others through the public profile function, which shapes it.",
                ],
                [
                  "friendships, telemetry, rate limits, AI output, model config",
                  "RLS on, zero policies",
                  "Reachable exclusively through definer functions. Deny by default.",
                ],
                [
                  "matchmaking_queue, challenges",
                  "Own rows; challenges also readable while open and unexpired",
                  "The accept flow needs to read a stranger's challenge, and only that.",
                ],
                [
                  "seasons, season_results, section_config",
                  "Public read",
                  "Scoring dials and standings are not secrets; hiding them would only obscure fairness.",
                ],
                [
                  "waitlist",
                  "Validated anonymous INSERT only",
                  "INSERT-not-UPDATE means a resubmit can never overwrite an existing row.",
                ],
                [
                  "avatars (storage)",
                  "Writes scoped to the uploader's own folder",
                  "Path-prefix check against the authenticated user id.",
                ],
              ]}
            />
            <P>
              Every policy wraps the auth-uid call as a scalar subquery. That
              single syntactic detail moves it into the query&apos;s InitPlan so it
              evaluates once per query rather than once per row — a
              linear-to-constant improvement on any policy-covered scan, and one
              the platform linter flags if it ever drifts back.
            </P>
            <P>
              Definer functions carry their own discipline: an explicit search path
              pinned <em>inline</em> on each function (a blanket pin is dropped the
              moment anything replaces the function — which once broke challenge
              creation), execute revoked from public and anonymous, then granted
              explicitly to the roles that need it. Read-only public functions —
              leaderboard, profile, recent matches — stay anonymously callable on
              purpose, because that is what makes the logged-out pages cacheable.
            </P>
          </Section>

          {/* ── 29 Limits ── */}
          <Section id="limits" n="29" title="Rate limiting">
            <P>
              Two independent durable layers, both backed by Postgres tables rather
              than process memory — an in-memory limiter is per-instance, and
              serverless instances multiply. The original in-memory implementation
              is gone.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Per-user, inside the function.</strong>{" "}
                  The check is the first statement and <em>raises</em> on exceed,
                  so the limit and the operation share one transaction and cannot
                  be raced apart. Answer submission, queue joining, and telemetry
                  each carry their own budget.
                </>,
                <>
                  <strong className="text-white">Per-IP, at the route handler.</strong>{" "}
                  Returns a retry-after rather than throwing, and <em>fails open</em>{" "}
                  on infrastructure error — deliberately, for unauthenticated
                  endpoints where a limiter outage must not become a site outage.
                </>,
                <>
                  <strong className="text-white">The metered AI routes fail closed.</strong>{" "}
                  Opposite decision, opposite reason: failing open on a route that
                  costs real money per call is a billing incident rather than an
                  availability win. The two directions are chosen per route, not
                  globally.
                </>,
              ]}
            />
            <P>
              Because the API routes sit outside the auth proxy, these inline
              limiters are the only thing standing between a public domain and the
              most expensive call in the product. That is stated in the codebase in
              exactly those words, next to the code that depends on it.
            </P>
          </Section>

          {/* ── 30 Email ── */}
          <Section id="email" n="30" title="The email layer">
            <P>
              Two transactional emails: a challenge invite and a match result. Both
              were an <strong className="text-white">open relay</strong> in an
              early version, which is a real finding rather than a hypothetical one
              — an endpoint that takes a recipient and a body and sends mail from
              your domain is a spam cannon with your reputation attached.
            </P>
            <List
              items={[
                <>
                  The challenge route verifies the caller <em>owns</em> the
                  challenge and that it has not expired, and reads the rated flag
                  from the database rather than the request body.
                </>,
                <>
                  The result route verifies the caller is a participant in the
                  match, and sends only to the caller&apos;s own authenticated
                  email address — the recipient is never a request parameter.
                </>,
                <>Both carry per-user and per-IP limits on top.</>,
              ]}
            />
          </Section>

          {/* ── 31 Headers ── */}
          <Section id="headers" n="31" title="HTTP hardening">
            <P>
              Security headers are applied to every path from the framework config,
              and the Content-Security-Policy is derived rather than wildcarded:
              the database origin is parsed at build time so the policy can allow
              exactly that host over HTTPS and its WebSocket endpoint, and nothing
              else.
            </P>
            <Table
              head={["Header", "Value", "What it stops"]}
              rows={[
                ["Content-Security-Policy", "self + the one database origin; no object, no embed", "Third-party script and connection exfiltration"],
                ["frame-ancestors / X-Frame-Options", "none / DENY", "Clickjacking the match screen"],
                ["Strict-Transport-Security", "2 years, includeSubDomains, preload", "Downgrade and first-visit interception"],
                ["Permissions-Policy", "camera, microphone, geolocation, topics all denied", "Silent capability access; ad-topics profiling"],
                ["X-Content-Type-Options", "nosniff", "MIME confusion on user-uploaded avatars"],
                ["Referrer-Policy", "strict-origin-when-cross-origin", "Leaking match and profile paths to third parties"],
              ]}
            />
            <P>
              Browser source maps are disabled in production builds, so the
              client&apos;s original source and internal naming are not shipped to
              every visitor. The policy still permits inline script and styles,
              because the framework&apos;s bootstrap requires it absent a nonce
              pipeline threaded through the proxy — an honest, documented limitation
              rather than an unnoticed one.
            </P>
          </Section>

          {/* ── 32 Migrations ── */}
          <Section id="migrations" n="32" title="Migration discipline">
            <P>
              With gameplay logic living in the database, migrations <em>are</em>{" "}
              the deployment mechanism, and migration mistakes are gameplay bugs.
              Four categories have bitten, each now carrying a standing rule.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Replacing from a stale copy.</strong>{" "}
                  The single biggest regression vector — it has reverted a timeout
                  fix, reverted the option shuffle, and silently dropped an admin
                  seed. Rule: always start from the <em>latest</em> definition of a
                  function, and re-check its invariant partners.
                </>,
                <>
                  <strong className="text-white">Adding a parameter forks an overload.</strong>{" "}
                  A different argument list is a different function, so replacing
                  with an extra defaulted parameter leaves the old function alive
                  beside the new one, and an exact-arity call binds to the{" "}
                  <em>old</em> one. That orphaned two of the question pickers: no
                  error, plausible questions returned, and a fixed exploit quietly
                  back in production. Rule: drop and create whenever a signature
                  grows, then verify exactly one candidate remains — and for a
                  client-reachable function, two candidates make the call ambiguous,
                  so it fails loudly instead, which is the better outcome.
                </>,
                <>
                  <strong className="text-white">Tracking drift.</strong> Applying a
                  migration through the management API records it under the{" "}
                  <em>apply-time</em> version rather than the file&apos;s, after
                  which the CLI refuses everything because it sees a remote version
                  with no local file. Rule: push through the CLI, which records the
                  file version and makes the drift impossible.
                </>,
                <>
                  <strong className="text-white">Repairing without verifying.</strong>{" "}
                  Marking a migration applied to clear an error permanently hides
                  whatever difference was real. Rule: compare the function body hash
                  in the live database against the file before marking anything
                  applied — a tracking row with no recorded statements was never
                  actually run, it is a bare row from a previous repair.
                </>,
              ]}
            />
            <Note title="The root cause was an identity problem, not a tooling one">
              The recurring tracking drift traced back to the CLI being signed into
              the wrong account for a long stretch. Its permission error read
              exactly like a privileges bug and was not one — no grant could have
              fixed it, because the account simply could not see the project. With
              the CLI apparently unusable, every session fell back to the management
              API, which is precisely what drifted the tracking. The rule that came
              out of it is diagnostic rather than technical:{" "}
              <em>verify identity before believing any authorisation failure</em>.
            </Note>
          </Section>

          <PartRule label="Part VII — Content pipeline" />

          {/* ── 33 Ingest ── */}
          <Section id="ingest" n="33" title="From PDF to question bank">
            <P>
              The bank was built from 29 years of past papers — a 915-page PDF with
              no machine-readable structure. Turning that into 3,168 typed, rated,
              embedded rows was its own engineering problem, and it is scripted
              rather than manual so it can be re-run and audited.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Structural mapping first.</strong>{" "}
                  A pass over the document establishes where sections and papers
                  begin before any question is extracted, so extraction runs against
                  known boundaries instead of guessing from formatting.
                </>,
                <>
                  <strong className="text-white">Two-pass join.</strong> Questions
                  and answer keys live in different parts of the document and are
                  extracted separately, then joined — which also makes an unmatched
                  key a loud failure instead of a silently wrong answer.
                </>,
                <>
                  <strong className="text-white">OCR where vision failed.</strong>{" "}
                  The DILR sections are dense with tables and figures. Direct vision
                  extraction hit a content filter mid-run, so that path was switched
                  to a dedicated OCR API — a pragmatic swap rather than a fight with
                  a classifier.
                </>,
                <>
                  <strong className="text-white">Diagrams are uploaded separately.</strong>{" "}
                  Questions that depend on a figure carry an uploaded image rather
                  than a lossy textual description of it.
                </>,
                <>
                  <strong className="text-white">Staged, then loaded.</strong>{" "}
                  Extraction output is staged and reviewed before it becomes live
                  rows, per section and per batch, so a bad extraction run never
                  reaches players.
                </>,
              ]}
            />
            <Note title="Ingest writes bypass the admin path — so validation lives in the database">
              These loaders write through the service role, not through the
              application&apos;s admin functions. Any rule enforced only in the
              application layer would therefore not apply to the writer that
              produced most of the bank. That is the concrete reason the
              numeric-TITA rule is a database constraint: the check has to sit where
              every writer must pass it, not where the convenient writer passes it.
            </Note>
          </Section>

          {/* ── 34 Enrichment ── */}
          <Section id="enrichment" n="34" title="Enrichment passes">
            <P>
              Extraction produces rows. Four idempotent passes turn them into a
              usable bank. Every one of them selects only the rows that still need
              work, which is what makes re-running them the repair path rather than
              a risk.
            </P>
            <Table
              head={["Pass", "What it does", "Idempotency"]}
              rows={[
                [
                  "Caselet regrouping",
                  "Reconstructs shared DILR caselets from atomized rows by longest-common-prefix",
                  "Skips rows that already carry a passage id",
                ],
                [
                  "Difficulty rating",
                  "Re-seeds flat-seeded VARC difficulty from an LLM judgment",
                  "Targets the flat-seeded set only",
                ],
                [
                  "Explanation backfill",
                  "Generates worked explanations where none were extracted",
                  "Selects rows missing an explanation",
                ],
                [
                  "Embedding backfill",
                  "Embeds question bodies for similarity search",
                  "Selects null embeddings only; the staleness trigger re-nulls edited rows for it",
                ],
              ]}
            />
            <P>
              Seed difficulty maps onto the rating scale as{" "}
              <Code>1000 + difficulty × 100</Code>, with the TITA offset on top.
              Seeding happens on insert only and{" "}
              <strong className="text-white">never on update</strong> — because an
              update-time seed would stomp a rating the question had spent twenty
              serves learning, replacing a measurement with the original guess.
            </P>
            <P>
              The scripts share one environment loader, written after a stale shell
              export shadowed the real key twice and produced an upstream error
              naming neither the key nor its source. The loader makes the local file
              win and prints one line when they disagree — a two-line fix for a
              class of bug that cost hours across two separate days.
            </P>
          </Section>

          {/* ── 35 Bank ── */}
          <Section id="bank" n="35" title="The bank today">
            <P>
              Live counts, straight from production. 3,168 active questions across
              289 passage groups; 14 further rows are deactivated rather than
              deleted, because deleting a question orphans the answers referencing
              it.
            </P>
            <Table
              head={["Section", "In passage groups", "Standalone", "TITA", "Total active"]}
              rows={[
                ["VARC", "747 (121 passages)", "345 jumbles & vocabulary", "—", "1,092"],
                ["DILR", "682 (168 caselets)", "252", "34", "934"],
                ["Quant", "— (all standalone)", "1,090", "52", "1,142"],
              ]}
            />
            <P>
              Every active row is embedded. The Quant TITA count is the one number
              on this page we would most like to change: 52 items served at a
              one-in-three quota are drawn about seven times as often as a given
              MCQ, which is a content problem with a content fix, not a reason to
              serve fewer.
            </P>
          </Section>

          <PartRule label="Part VIII — Craft & operations" />

          {/* ── 36 Design ── */}
          <Section id="design" n="36" title="Design system">
            <P>
              Dark-only, single-theme, and deliberately not themeable. A theme
              switch is a second design to maintain, and there is no evidence the
              audience wants one at 11pm the night before a mock.
            </P>
            <Table
              head={["Token", "Value", "Role"]}
              rows={[
                ["Page ground", "#120F17", "Near-black violet — chosen, not a default grey"],
                ["Surfaces", "#111111", "Cards and panels"],
                ["Accent", "#06d6a0", "Mint — the only call-to-action colour in the product"],
                ["Ratings", "#ffd166", "Gold — anything numeric and earned"],
                ["Losses", "#ef476f", "Pink — the only negative signal"],
                ["Cool incidental", "#7ab5cc", "Secondary text, code, metadata"],
              ]}
            />
            <P>
              Type pairs a neutral sans for body with a pixel display face for
              headings and a monospace for anything numeric or code-shaped. Numbers
              are tabular-lined everywhere they can change, so a rating ticking
              upward doesn&apos;t reflow the row it lives in.
            </P>
            <P>
              Component code writes raw hex arbitrary values rather than semantic
              token classes. That is a deliberate consistency choice with a stated
              trade: a theme migration would be a find-and-replace, and in exchange
              every colour in a component is legible at the point of use without
              resolving an indirection.
            </P>
          </Section>

          {/* ── 37 Motion ── */}
          <Section id="motion" n="37" title="Motion vocabulary">
            <P>
              One module defines every motion in the product, imported by every
              screen, so the app has a single movement identity rather than whatever
              each page&apos;s author felt like.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Verdicts stamp.</strong> Anything
                  conclusive — matched, points awarded, win or loss, rating delta —
                  lands with a scale-down and a single beat. Nothing else in the
                  product is allowed to stamp, which is what makes it read as a
                  verdict.
                </>,
                <>
                  <strong className="text-white">Everything else rises quietly</strong>{" "}
                  on a fast-start, decisive-stop curve, staggered.
                </>,
                <>
                  <strong className="text-white">Numbers roll like odometers</strong>{" "}
                  — which is why they are tabular-lined.
                </>,
                <>
                  <strong className="text-white">Reduced motion is an early return, not a slower tween.</strong>{" "}
                  Every entrance animates <em>from</em> an offset, so skipping the
                  animation leaves the DOM at its natural final state. Users who ask
                  for less motion get the finished layout instantly rather than a
                  gentler version of the same wait.
                </>,
                <>
                  <strong className="text-white">Entrances never block interaction.</strong>{" "}
                  Opacity and transform only; elements are clickable mid-tween.
                </>,
                <>
                  <strong className="text-white">Server pages stay server pages.</strong>{" "}
                  A small client wrapper takes server-rendered content as children
                  and animates it, so adding motion to a page does not convert its
                  content into JavaScript. This page uses it.
                </>,
              ]}
            />
          </Section>

          {/* ── 38 Perf ── */}
          <Section id="perf" n="38" title="Performance">
            <List
              items={[
                <>
                  <strong className="text-white">Local JWT verification in the auth proxy.</strong>{" "}
                  Claims are verified locally against asymmetric signing keys
                  instead of an auth-server round trip on <em>every single request</em>
                  . This is the single largest per-request cost reduction in the app.
                </>,
                <>
                  <strong className="text-white">The onboarding gate costs one lookup per session.</strong>{" "}
                  A cookie caches the completed state, so the database check happens
                  at most once — which is what stops the gate from immediately
                  undoing the optimisation above.
                </>,
                <>
                  <strong className="text-white">Public pages are cookieless and cached.</strong>{" "}
                  Leaderboard and profiles render through a session-less client with
                  60-second incremental regeneration. &quot;You&quot;-highlighting
                  is resolved client-side <em>specifically</em> so the page itself
                  stays cacheable for everyone rather than being personalised per
                  viewer.
                </>,
                <>
                  <strong className="text-white">Authed pages are never bfcached.</strong>{" "}
                  A no-store header on authenticated responses, because the
                  browser&apos;s Back button restores the last rendered page{" "}
                  <em>without re-running middleware</em> — which after logout means
                  an authed screen back on screen.
                </>,
                <>
                  <strong className="text-white">Foreign keys are indexed.</strong>{" "}
                  Nine were added in one hardening pass after the linter flagged
                  them; an unindexed foreign key turns every cascading delete into a
                  sequential scan.
                </>,
                <>
                  <strong className="text-white">Embeddings are stored inline.</strong>{" "}
                  See <A href="#embeddings">Vector search</A> — 677ms to 4.8ms on
                  the same query.
                </>,
                <>
                  <strong className="text-white">The landing gradient never touches the server.</strong>{" "}
                  The WebGL layer is mounted client-only behind the scroll
                  container, so it is absent from server HTML entirely, and the
                  landing page deliberately does not open a realtime connection.
                </>,
              ]}
            />
          </Section>

          {/* ── 39 Cron ── */}
          <Section id="cron" n="39" title="Scheduled jobs">
            <P>
              Three cron jobs run inside Postgres. No external scheduler, no worker
              fleet, nothing to deploy separately or page someone about.
            </P>
            <Table
              head={["Job", "Cadence", "Work"]}
              rows={[
                [
                  "Timeout drain",
                  "Every minute",
                  "Abandons no-shows pending over two minutes; writes skip rows for expired questions against each player's own clock; advances or finalises.",
                ],
                [
                  "Queue sweep",
                  "Every minute",
                  "Cancels waiting rows whose heartbeat is over 90 seconds stale; prunes finished rows older than a day.",
                ],
                [
                  "Season rollover",
                  "Hourly",
                  "Snapshots standings, applies the soft rating reset, writes reset markers into rating history.",
                ],
              ]}
            />
            <P>
              The timeout drain writes its skip rows with a{" "}
              <strong className="text-white">null elapsed time</strong>. That null
              is not missing data — it is the marker distinguishing a cron-written
              timeout from a genuine client submission, which always records a
              duration. Several systems key on it: forfeit evidence, debrief
              accuracy, and the coach&apos;s learner profile, which excludes
              timeouts from accuracy rates rather than counting them as deliberate
              skips. A player whose train went through a tunnel is not a player who
              gave up.
            </P>
          </Section>

          {/* ── 40 Testing ── */}
          <Section id="testing" n="40" title="How the invariants are verified">
            <P>
              Game-critical logic is verified by SQL harnesses that run inside a
              transaction and roll back — real rows, real functions, real
              constraints, no residue. They assert properties, not implementations,
              which is what lets a function be rewritten without rewriting its test.
            </P>
            <List
              items={[
                <>Rating transfers are strictly zero-sum and never breach the floor.</>,
                <>
                  Guessing is EV-neutral at every point on the time curve and at
                  every option count.
                </>,
                <>
                  The three option-shuffle functions agree — the exact regression
                  that once shipped silently.
                </>,
                <>
                  Exactly one time-cap source is consulted by every function in a
                  match context, so timers cannot desync.
                </>,
                <>
                  Self-paced progression: each player advances independently and the
                  match finalises only when both hold nine answers.
                </>,
                <>
                  Every user-facing AI route is blocked mid-match, including when it
                  points at an unrelated completed match.
                </>,
                <>
                  Queue behaviour under concurrency: no double-booking, no deadlock,
                  the rated-pair cap holds.
                </>,
              ]}
            />
            <P>Alongside them, four checks that need no network and no credentials:</P>
            <Table
              head={["Check", "Guards"]}
              rows={[
                ["Question-rating Monte Carlo", "The K values and result formula, on a deterministic seed"],
                ["Prompt self-test", "The MCQ and TITA construction branches"],
                ["Coach cost self-test", "The curve cap and — separately — that the trim takes the tail"],
                ["Environment loader self-test", "That the local file beats a stale shell export"],
              ]}
            />
            <P>
              Plus one that deliberately spends money: a live end-to-end probe
              costing about $0.004 per question, which reproduces the real model
              path against a real question and grades the answer against the real
              key. Everything a mock could tell us is already covered by the others;
              what this catches is the model actually being wrong.
            </P>
            <Note title="A testing trap worth knowing">
              Generating test rows with a series does <em>not</em> exercise a
              volatile function repeatedly — the planner folds it to a single call,
              so a test that appears to sample a random-selection function a
              thousand times may have sampled it once and copied the answer. The
              measured TITA-per-block table in{" "}
              <A href="#question-elo">Question ELO</A> exists because this trap was
              caught; the first version of that measurement was reporting one draw a
              thousand times.
            </Note>
          </Section>

          {/* ── 41 Deploy ── */}
          <Section id="deploy" n="41" title="Deployment topology">
            <P>
              One repository builds two production projects from the same branch,
              differing only by environment variable. The public waitlist site and
              the full battle app are, by construction, the identical commit — the
              front door is chosen by one variable at runtime, not by a code branch
              or a long-lived release branch.
            </P>
            <P>
              That means the launch is the removal of one environment variable: no
              deploy, no merge, no migration. It also means an accidental deletion
              of that variable launches the product — precisely the kind of fact
              that belongs written down rather than discovered.
            </P>
            <P>
              An earlier setup used a build-ignore guard to freeze the public site
              while the trunk moved. It was deleted once both domains were meant to
              track the trunk: a guard permanently defeatable by an environment
              variable, and invisible in the repository, is worse than no guard — it
              is exactly the failure it was written to prevent. If the freeze is ever
              needed again it comes back as a file in the repo, not a setting in a
              dashboard, so there is one source of truth.
            </P>
            <P>
              The topology has its own trap, documented because it has already
              caused wrong conclusions: the staging project deploys as its{" "}
              <em>own production</em>, so gating behaviour on the platform&apos;s
              environment variable is a silent no-op there, and it answers on two
              public hostnames, so a hostname check leaves one of them uncovered.
              Anything environment-specific is gated on a project-scoped variable
              instead.
            </P>
          </Section>

          {/* ── 42 Limitations ── */}
          <Section id="limitations" n="42" title="Honest limitations">
            <P>
              A technology page that only lists strengths is marketing. These are
              the known weak points, stated as they are recorded internally.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Generated types lag the schema.</strong>{" "}
                  Migrations move faster than the generated TypeScript definitions,
                  so client code carries type assertions in places. The fix is
                  regeneration, not more assertions — and it is written that way in
                  the guidance so the workaround doesn&apos;t become the convention.
                </>,
                <>
                  <strong className="text-white">The TITA bank is thin.</strong> 52
                  Quant items at a one-in-three quota repeat within about ten
                  matches. Accepted openly, because the alternative — reverting the
                  quota — restores a 0% floor for most of the ladder.
                </>,
                <>
                  <strong className="text-white">The vector search has no consumer.</strong>{" "}
                  Embeddings and search are built and unused. Wiring them up is
                  gated on the oracle problem being solved properly rather than
                  quickly.
                </>,
                <>
                  <strong className="text-white">The CSP still allows inline script.</strong>{" "}
                  Removing it needs a nonce pipeline threaded through the proxy.
                  Known, scoped, not yet done.
                </>,
                <>
                  <strong className="text-white">Rating constants are unvalidated at scale.</strong>{" "}
                  The K values and margin split are principled but not yet tuned
                  against real outcomes; the calibration query exists and is waiting
                  on volume. We would rather say that than present untested
                  constants as measured ones.
                </>,
                <>
                  <strong className="text-white">The admin console was removed, its functions were not.</strong>{" "}
                  The interface is deleted from the application; the underlying
                  database functions remain because dropping them is a production
                  migration that has not earned priority. Content work goes through
                  the scripted pipeline instead.
                </>,
                <>
                  <strong className="text-white">Some dead code survives.</strong> A
                  handful of unreferenced components are tracked rather than quietly
                  left — one of them is the only reason a WebGL dependency is still
                  in the tree.
                </>,
              ]}
            />
          </Section>

          {/* ── 43 Numbers ── */}
          <Section id="numbers" n="43" title="The numbers">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 mb-8">
              {[
                ["104", "migrations"],
                ["95", "Postgres functions"],
                ["3,168", "active questions"],
                ["289", "passage groups"],
                ["9", "questions per match"],
                ["140", "max points/question, every section"],
                ["3", "realtime primitives, 3 trust levels"],
                ["1,000", "starting rating"],
                ["2s", "fast-answer exclusion floor"],
                ["30", "rating points fed to the coach"],
                ["$0.0008", "cheapest AI call"],
                ["0", "client-trusted game inputs"],
              ].map(([v, l]) => (
                <div
                  key={l}
                  className="rounded-xl border border-[#222222] bg-[#111111] p-5"
                >
                  <div className="font-mono text-2xl text-[#06d6a0] tabular-nums">
                    {v}
                  </div>
                  <div className="text-white/45 text-xs mt-1.5 leading-snug">
                    {l}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ── 44 Glossary ── */}
          <Section id="glossary" n="44" title="Glossary">
            <Table
              head={["Term", "Meaning here"]}
              rows={[
                ["VARC", "Verbal Ability & Reading Comprehension — one of the three CAT sections"],
                ["DILR", "Data Interpretation & Logical Reasoning — caselet-based, the most structure-heavy section"],
                ["TITA", "Type In The Answer — a question with no options and therefore no guess floor"],
                ["Caselet", "A shared DILR scenario with several questions hanging off it"],
                ["Passage group", "The general form of a caselet: questions that must be served together"],
                ["Reading window", "Extra, bonus-free time on the first question of a passage group"],
                ["Definer function", "A database function that runs with the table owner's privileges, bypassing RLS"],
                ["RLS", "Row-Level Security — per-row access rules enforced by the database itself"],
                ["Self-paced", "Each player has their own clock and position; the match ends when both finish"],
                ["Lockstep", "The older shared-clock model, retained only for bot matches"],
                ["Nudge", "The small rating update a question receives from each answer"],
                ["Starvation cliff", "A content type never being served because a one-dimensional selector can't see it"],
                ["Pre-spend ceiling", "An attempt cap checked before the model is called, not after"],
                ["Reasoning tokens", "Model output that bills and consumes the budget before any answer text exists"],
              ]}
            />
          </Section>

          {/* Closing */}
          <div className="mt-20 rounded-2xl border border-[#06d6a0]/25 bg-[#111111] px-8 py-12 text-center">
            <h2 className="font-pixel text-[clamp(1.5rem,3vw,2.2rem)] leading-tight mb-4">
              Every rating on the board was earned against this.
            </h2>
            <p className="text-[#c5e8f0]/70 text-base max-w-[46ch] mx-auto mb-8">
              Server-scored, per-player-shuffled, rate-limited, AI-gated, and
              impossible to fake from a browser console.
            </p>
            <Link
              href={CTA_HREF}
              className="inline-flex items-center justify-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-7 py-3 hover:bg-[#05b088] transition-colors"
            >
              {IS_WAITLIST ? "Join the waitlist →" : "Enter the arena →"}
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ── Presentational helpers ─────────────────────────────────────────── */

function PartRule({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 my-16">
      <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#06d6a0]/70 shrink-0">
        {label}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-[#06d6a0]/25 to-transparent" />
    </div>
  );
}

function Section({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 mb-20">
      <div className="flex items-baseline gap-4 mb-6 pb-4 border-b border-[#222222]">
        <span className="font-mono text-xs text-[#06d6a0]/60">{n}</span>
        <h2 className="font-pixel text-[clamp(1.4rem,2.6vw,2rem)] leading-tight">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-pixel text-lg mt-10 mb-3 text-[#ffd166]">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[#c5e8f0]/75 text-[15px] leading-[1.75] mb-5 max-w-[68ch]">
      {children}
    </p>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-[#06d6a0] hover:underline underline-offset-2">
      {children}
    </a>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[13px] text-[#7ab5cc] bg-[#7ab5cc]/[0.08] rounded px-1.5 py-0.5">
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="rounded-xl border border-[#222222] bg-[#0d0b12] p-5 mb-6 overflow-x-auto">
      <code className="font-mono text-[12.5px] leading-[1.7] text-[#c5e8f0]/85 whitespace-pre">
        {children}
      </code>
    </pre>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-4 mb-6 max-w-[68ch]">
      {items.map((it, i) => (
        <li
          key={i}
          className="flex gap-3 text-[#c5e8f0]/75 text-[15px] leading-[1.75]"
        >
          <span className="text-[#06d6a0] mt-[0.55rem] shrink-0 w-1.5 h-1.5 rounded-full bg-[#06d6a0]" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#ffd166]/20 bg-[#ffd166]/[0.04] p-6 mb-6 max-w-[68ch]">
      <p className="font-pixel text-sm text-[#ffd166] mb-3">{title}</p>
      <div className="text-[#c5e8f0]/70 text-[14.5px] leading-[1.7]">
        {children}
      </div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#222222] bg-[#111111] mb-6">
      <table className="w-full min-w-[560px] text-left border-collapse">
        <thead>
          <tr className="border-b border-[#222222]">
            {head.map((h) => (
              <th
                key={h}
                className="p-4 font-mono text-[11px] uppercase tracking-wider text-white/40 font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-[#1a1a1a] last:border-0 align-top"
            >
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`p-4 text-[14px] leading-relaxed ${
                    j === 0 ? "text-white/85 font-medium" : "text-[#c5e8f0]/65"
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Layers() {
  const layers = [
    {
      n: "Client",
      c: "#7ab5cc",
      d: "React renders state and calls RPCs. It holds no authority over anything that affects a rating.",
    },
    {
      n: "Postgres",
      c: "#06d6a0",
      d: "Matchmaking, scoring, rating math, content selection, timeouts, and seasons — all inside security-definer functions with RLS underneath.",
    },
    {
      n: "AI layer",
      c: "#ffd166",
      d: "Route handlers that read the player's own aggregates and call a model — and refuse to run at all while a match is live.",
    },
  ];
  return (
    <div className="grid sm:grid-cols-3 gap-4 mb-6">
      {layers.map((l) => (
        <div
          key={l.n}
          className="rounded-xl border border-[#222222] bg-[#111111] p-5"
        >
          <div className="font-pixel text-sm mb-2" style={{ color: l.c }}>
            {l.n}
          </div>
          <p className="text-[#c5e8f0]/60 text-[13px] leading-relaxed">{l.d}</p>
        </div>
      ))}
    </div>
  );
}
