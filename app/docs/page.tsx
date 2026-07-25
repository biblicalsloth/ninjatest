import type { Metadata } from "next";
import Link from "next/link";
import { NinjatestLogo } from "@/components/ninja-logo";

export const metadata: Metadata = {
  title: "Docs — Ninjatest",
  description:
    "How Ninjatest works under the hood: server-authoritative game logic in Postgres, self-paced realtime matches, dual ELO systems, and an AI layer that refuses to run while you're playing.",
};

// ponytail: pure server component — sticky TOC + #anchors need no JS.
// Zero client bundle for a page that is entirely prose.

const TOC: { id: string; label: string }[] = [
  { id: "overview", label: "System overview" },
  { id: "stack", label: "The stack" },
  { id: "authority", label: "Server authority" },
  { id: "matchmaking", label: "Matchmaking" },
  { id: "engine", label: "Self-paced match engine" },
  { id: "scoring", label: "Scoring math" },
  { id: "player-elo", label: "Player ELO" },
  { id: "question-elo", label: "Question ELO" },
  { id: "realtime", label: "Realtime transport" },
  { id: "anticheat", label: "Anti-cheat" },
  { id: "ninja", label: "Ninja AI layer" },
  { id: "embeddings", label: "Vector search" },
  { id: "data", label: "Data model & RLS" },
  { id: "limits", label: "Rate limiting" },
  { id: "perf", label: "Performance" },
  { id: "cron", label: "Scheduled jobs" },
  { id: "testing", label: "How it's verified" },
  { id: "deploy", label: "Deployment" },
  { id: "numbers", label: "Numbers" },
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
            href="/auth/signup"
            className="text-[#06d6a0] hover:text-white text-sm font-semibold transition-colors"
          >
            Sign up →
          </Link>
        </div>
      </nav>

      <div className="max-w-[1180px] mx-auto px-6 sm:px-10 grid lg:grid-cols-[220px_minmax(0,1fr)] gap-12 pb-28">
        {/* Sidebar */}
        <aside className="hidden lg:block">
          <div className="sticky top-24 py-14">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/30 mb-4">
              Contents
            </p>
            <ul className="space-y-2 border-l border-[#222222] pl-4">
              {TOC.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className="text-white/45 hover:text-[#06d6a0] text-[13px] leading-snug transition-colors block"
                  >
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="py-14 min-w-0">
          {/* Hero */}
          <header className="mb-16">
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#06d6a0] mb-5">
              Engineering / Architecture
            </p>
            <h1 className="font-pixel text-[clamp(2.2rem,4.6vw,3.6rem)] leading-[1.04] text-balance">
              The technology behind{" "}
              <span className="text-[#06d6a0]">Ninjatest</span>
            </h1>
            <p className="mt-7 text-[#c5e8f0]/75 text-lg font-light leading-relaxed max-w-[62ch]">
              Ninjatest is a real-time, ELO-rated 1v1 competitive exam arena. Two
              aspirants, nine questions, one rating on the line. That premise
              forces an uncomfortable engineering constraint: <em>nothing</em> the
              client says about time, correctness, or rating can be believed.
            </p>
            <p className="mt-5 text-[#c5e8f0]/60 text-base font-light leading-relaxed max-w-[62ch]">
              What follows is the actual shipped architecture — the invariants,
              the math, the failure modes we hit, and the reasoning behind each
              decision. No diagrams of systems we intend to build. Only what runs.
            </p>

            <div className="mt-9 flex flex-wrap gap-2">
              {[
                "Next.js 16 / React 19",
                "Postgres-authoritative",
                "Supabase Realtime",
                "pgvector",
                "OpenRouter LLM layer",
              ].map((t) => (
                <span
                  key={t}
                  className="font-mono text-[11px] text-[#7ab5cc] bg-[#7ab5cc]/[0.07] border border-[#7ab5cc]/15 rounded-full px-3 py-1"
                >
                  {t}
                </span>
              ))}
            </div>
          </header>

          {/* ── Overview ── */}
          <Section id="overview" n="01" title="System overview">
            <P>
              A Ninjatest match is nine questions — three VARC, three DILR, three
              Quant, or nine from a single section in a section-mode challenge.
              Each player traverses their own nine on their own clock. Every
              answer is scored on the server against a clock the server started,
              and the winner is decided only once both players have finished.
            </P>
            <P>
              Architecturally the product is three layers, and the middle one is
              deliberately thin:
            </P>
            <Layers />
            <P>
              The unusual choice is layer two. There is no Node game server, no
              Edge Function tier, no queue worker. All game-critical logic lives
              in <Code>security definer</Code> Postgres functions — 95 of them
              across 104 migrations. The client can only call an RPC and render
              what comes back.
            </P>
            <Note title="Why the logic lives in the database">
              A separate game server would need its own consensus with Postgres
              about who answered what and when. Putting the scoring transaction
              and the row it mutates in the same place removes that class of bug
              entirely: matchmaking pairing, answer scoring, and rating transfer
              are each a single atomic transaction with row locks, not a
              distributed handshake. The cost is that game logic is written in
              PL/pgSQL, and migrations are the deployment mechanism for
              gameplay changes. We took that trade knowingly.
            </Note>
          </Section>

          {/* ── Stack ── */}
          <Section id="stack" n="02" title="The stack">
            <Table
              head={["Layer", "Choice", "Why"]}
              rows={[
                [
                  "Framework",
                  "Next.js 16 App Router, React 19",
                  "RSC for public pages, route handlers for the AI layer, proxy.ts for the auth gate.",
                ],
                [
                  "Database + Auth",
                  "Supabase (Postgres 15, RLS, GoTrue)",
                  "Row-Level Security is the last line of defence; definer RPCs are the first.",
                ],
                [
                  "Game logic",
                  "PL/pgSQL security-definer functions",
                  "Scoring and the row it writes share one transaction. No Edge Functions.",
                ],
                [
                  "Realtime",
                  "Supabase Realtime — Broadcast, Presence, Postgres Changes",
                  "Three channels with three distinct trust levels. See Realtime transport.",
                ],
                [
                  "Scheduled work",
                  "pg_cron",
                  "Timeout draining, stale-queue sweeps, and season rollovers run inside the DB.",
                ],
                [
                  "AI",
                  "OpenRouter (one key, one provider)",
                  "Model routing is a database row, so switching models needs no deploy.",
                ],
                [
                  "Vector search",
                  "pgvector, 1536-d, exact cosine",
                  "3,100+ questions embedded. Exact scan beats HNSW at this size, with no recall loss.",
                ],
                [
                  "UI",
                  "Tailwind v4, shadcn/ui, GSAP",
                  "Dark-only, one accent colour, one motion vocabulary in lib/motion.ts.",
                ],
                [
                  "Hosting",
                  "Vercel — one repo, two production projects",
                  "The public waitlist and the full app are the same commit, split by one env var.",
                ],
              ]}
            />
          </Section>

          {/* ── Authority ── */}
          <Section id="authority" n="03" title="The server-authority invariant">
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
              question-serving RPC strips <Code>correct_index</Code> and{" "}
              <Code>explanation</Code> before the row ever leaves Postgres, so
              &quot;inspect the network tab&quot; returns exactly what the UI
              shows. The explanation arrives only in the reveal call, after the
              answer is locked.
            </P>
            <P>
              Forfeits work the same way. A client claiming &quot;my opponent
              left&quot; proves nothing, so <Code>forfeit_match</Code> requires a
              server-verifiable absence: the opponent must have missed a full
              question deadline plus a five-second grace with no submitted row,
              or already carry a cron-written timeout marker on the previous
              question. The client retries the call every ten seconds and the
              server keeps refusing until its own evidence is satisfied.
            </P>
          </Section>

          {/* ── Matchmaking ── */}
          <Section id="matchmaking" n="04" title="Matchmaking">
            <P>
              Pairing is the classic concurrency trap: two players poll at the
              same millisecond and both match with the same third player. The
              queue avoids it with a single atomic statement using{" "}
              <Code>FOR UPDATE SKIP LOCKED</Code> — the row a concurrent
              transaction is already claiming is skipped rather than waited on,
              so pairing never double-books and never deadlocks under load.
            </P>
            <P>The rating band widens with wait time:</P>
            <Pre>{`band = min(1000, 100 + wait_seconds × 20)   -- per player
match if |elo_a − elo_b| ≤ max(band_a, band_b)`}</Pre>
            <P>
              A fresh entrant sees only ±100 ELO. After 45 seconds the window is
              ±1000 and effectively anyone. This trades match quality for queue
              latency on a curve rather than a threshold.
            </P>
            <P>Three guards sit on top of the pairing:</P>
            <List
              items={[
                <>
                  <strong className="text-white">Rated-pair cap.</strong> The same
                  two accounts can play at most three <em>rated</em> matches per
                  day. Without it, two friends farm rating off each other
                  indefinitely. Never-rated abandons don&apos;t count toward the cap.
                </>,
                <>
                  <strong className="text-white">Live-match rejection.</strong>{" "}
                  <Code>join_queue</Code> refuses a caller already inside an
                  active match, which is also the definition the AI layer reuses.
                </>,
                <>
                  <strong className="text-white">Exactly-nine guard.</strong> A
                  match is refused unless the frozen question array holds exactly
                  nine ids. If a section is too thin to fill its slots, the
                  picker adaptively rolls those slots into another section rather
                  than shipping a short array — because a short array lets the
                  question index run past the end mid-play and corrupts the match.
                  On a genuine content gap the caller simply stays queued rather
                  than erroring.
                </>,
              ]}
            />
            <Note title="A bug that shipped and what it taught us">
              The truncation guard exists because the failure it prevents is
              silent. A match built from seven questions doesn&apos;t throw — it
              plays normally and then reads past the array on question eight.
              The lesson generalised into a rule we now apply everywhere:{" "}
              <em>
                if an invariant can be asserted at write time, assert it at write
                time
              </em>
              . The same guard was subsequently added to bot matches and friend
              challenges, which had independent code paths building the same
              array.
            </Note>
          </Section>

          {/* ── Engine ── */}
          <Section id="engine" n="05" title="The self-paced match engine">
            <P>
              Ninjatest originally ran matches in lockstep: one shared question
              index, both players advanced together, and the slower player
              dictated the pace. It was simpler and it was wrong. Reading speed
              is part of what a CAT aspirant is training, and lockstep either
              punishes the fast player with dead waiting time or rushes the
              careful one.
            </P>
            <P>
              The current engine gives each player their own clock and their own
              position. The critical design decision was to make position{" "}
              <strong className="text-white">derived, not stored</strong>:
            </P>
            <Pre>{`position(user) = count(match_answers where match_id = m and user_id = u)
                 -- 0..9, and 9 means finished`}</Pre>
            <P>
              There is no per-player index column, so there is nothing that can
              desynchronise from the rows that actually exist. A row written is a
              question advanced, by construction. Two columns hold the per-player
              question clocks; the serving and scoring RPCs read the{" "}
              <em>caller&apos;s</em> clock and advance only the caller. The match
              finalises when — and only when — both players hold nine answers.
            </P>
            <P>
              Bot matches deliberately kept the old shared-index path. The bot
              has no independent clock to run and its difficulty is derived from
              the question&apos;s own rating, so lockstep is both correct and
              cheaper there. All three lifecycle RPCs branch on whether a bot is
              present.
            </P>
            <Note title="The subtle part: readers you forget">
              Redefining what a column means breaks every reader of that column,
              including the ones you weren&apos;t thinking about. The shared index
              was retained — set to the minimum of the two player positions —
              purely so the spectator RPCs, which read it, always see an
              in-range question. Two readers were still missed on the first pass
              (the answer-reveal path and the spectator clock) and shipped as
              follow-up fixes. The takeaway that went into the engineering notes:
              grep every reader of a column whose meaning you change, not every
              writer.
            </Note>
          </Section>

          {/* ── Scoring ── */}
          <Section id="scoring" n="06" title="Scoring math">
            <P>
              Scoring is entirely server-side and every dial lives in a config
              table, never in application code. The per-question calculation:
            </P>
            <Pre>{`base    = coalesce(question.duration_ms, section_cap_ms)
cap     = base + reading_ms       -- only for the first question of a passage group
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
              different time caps, a flat multiplier would make one section worth
              more per question than another, and rating would then measure which
              section you drew rather than how well you played. Tuned, every
              section maxes at 140 points per question.
            </P>
            <P>
              The reading window is bonus-free by design. The first question of a
              passage group gets extra time to read the passage, but the bonus is
              computed against the base cap, so the extension is grace rather
              than free points.
            </P>

            <h3 className="font-pixel text-lg mt-10 mb-3 text-[#ffd166]">
              The wrong-answer penalty is derived, not configured
            </h3>
            <P>
              This is the piece we&apos;re proudest of. The penalty started as a
              config value — a flat −30. On four-option questions that made{" "}
              <em>instant blind guessing</em> worth roughly +9 expected points
              per question. A snap-guess bot would have out-scored a careful
              human.
            </P>
            <P>
              The penalty is now derived from the same speed curve as the reward,
              which makes a random guess exactly EV-neutral at every point in
              time and at any option count:
            </P>
            <Pre>{`E[guess] = p_correct × (base + bonus)  −  (1 − p_correct) × (base + bonus)/(n − 1)
         = (1/n)(base + bonus)  −  ((n−1)/n)(base + bonus)/(n − 1)
         = 0`}</Pre>
            <P>
              Guessing is worth exactly zero, whenever you do it, regardless of
              how many options the question has. As a bonus the ratio converges
              on CAT&apos;s own 1:3 marking scheme at the time cap. The retired
              config column is still in the table, unread — deleting it is a
              migration we haven&apos;t needed.
            </P>
          </Section>

          {/* ── Player ELO ── */}
          <Section id="player-elo" n="07" title="Player ELO">
            <P>
              Ratings use a modified Elo with a margin-of-victory term and a
              favourite correction:
            </P>
            <Pre>{`K        = 40 if games < 30 else 24 if elo < 2000 else 16
E_winner = 1 / (1 + 10^((R_loser − R_winner) / 400))
factor   = 0.3 + 0.7 × min(|score_margin| / FULL, 1)
factor  *= 2.2 / (0.001 × (R_winner − R_loser) + 2.2)   -- only if winner was favourite
Δ        = max(0, round(K × (1 − E_winner) × factor))
Δ_eff    = max(0, min(Δ, R_loser − 100))                -- rating floor
winner += Δ_eff ;  loser −= Δ_eff                       -- strictly zero-sum`}</Pre>
            <List
              items={[
                <>
                  <strong className="text-white">Margin matters, but not linearly.</strong>{" "}
                  A 0.3 floor means a narrow win still moves rating; the
                  remaining 0.7 scales with how decisive the win was, normalised
                  against the match&apos;s own maximum possible margin so
                  section-mode and mixed matches are comparable.
                </>,
                <>
                  <strong className="text-white">Favourite-shrink.</strong>{" "}
                  Margin-of-victory systems systematically overrate favourites,
                  because a strong player&apos;s margins are autocorrelated with
                  their strength. We apply the FiveThirtyEight-style correction
                  to favourite wins only; underdog wins are untouched.
                </>,
                <>
                  <strong className="text-white">Strictly zero-sum, with a floor.</strong>{" "}
                  The transfer is one number applied in both directions, clamped
                  so no one falls below 100. A consequence we accepted
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
                  Both players&apos; current ratings are read under ordered row
                  locks when the match ends, not snapshotted at match creation,
                  so overlapping matches chain correctly instead of applying to a
                  stale base. Ordered locking is what stops two simultaneous
                  finalisations from deadlocking.
                </>,
                <>
                  <strong className="text-white">Draws share one K.</strong> The
                  lower of the two K-factors, applied once. Per-player Ks used to
                  mint roughly +11 rating out of thin air on every mismatched
                  draw.
                </>,
              ]}
            />
            <P>
              Seasons apply a soft reset —{" "}
              <Code>elo = 1000 + (elo − 1000) / 2</Code> — snapshotting the old
              standings to a results table and writing a reset marker into the
              rating history so the profile graph shows the discontinuity
              honestly rather than pretending it was a loss streak.
            </P>
          </Section>

          {/* ── Question ELO ── */}
          <Section id="question-elo" n="08" title="Question ELO — adaptive difficulty">
            <P>
              Every question carries its own rating, and it moves. When a player
              answers in a rated or bot match, one atomic UPDATE nudges the
              question&apos;s rating in the opposite direction of the outcome:
            </P>
            <Pre>{`result = 1.0                      if wrong
       = 0.35 × (taken_ms / cap)   if correct   -- fast + correct ⇒ question is easy
K      = 32 while times_seen < 20 else 16
clamp  [400, 2800]`}</Pre>
            <P>
              Over roughly twenty serves, a question converges on the rating at
              which players get it right half the time — an empirical difficulty
              measurement rather than an author&apos;s guess. Selection then
              biases toward the players&apos; mean rating with{" "}
              <Code>random() × 300</Code> jitter, so matches are challenging
              without being deterministic.
            </P>
            <P>Three exclusions keep the signal clean:</P>
            <List
              items={[
                <>
                  Answers faster than two seconds are discarded, correct or
                  wrong. They&apos;re either a misclick or an automation attempt,
                  and both would corrupt the difficulty curve.
                </>,
                <>
                  Unrated player-vs-player matches never nudge. An uncapped
                  unrated challenge between two colluding accounts was a direct
                  write channel into the question bank.
                </>,
                <>
                  In bot matches only the human&apos;s answer nudges. The
                  bot&apos;s behaviour is <em>derived from</em> the question
                  rating, so letting it write back would be a feedback loop
                  measuring itself.
                </>,
              ]}
            />

            <h3 className="font-pixel text-lg mt-10 mb-3 text-[#ffd166]">
              The starvation cliff: why selection can&apos;t be rating alone
            </h3>
            <P>
              CAT has two question types: multiple-choice, and TITA — Type In The
              Answer, with no options and therefore no guess floor. Identical
              content is genuinely harder as TITA, so TITA seeds sit 100 rating
              points above the MCQ scale. We sized that offset from the
              nudge&apos;s own steady state rather than guessing:
            </P>
            <Pre>{`E[result] = 1 − 0.8p        (p = probability the player knows it)
gap(p)    = −400 × log10(0.8p / (1 − 0.8p))
          = +133 / +70 / +37   at p = 0.25 / 0.50 / 0.75`}</Pre>
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
              A cliff, not a gradient. Below 1400 a player never saw a TITA at
              all — and the failure was self-sealing, because a question that is
              never served is never re-rated and can never migrate out of the
              dead zone. Rating is a one-dimensional signal and question{" "}
              <em>type</em> is a second dimension it cannot express.
            </P>
            <P>
              The fix is a hard quota: one of every three Quant slots is reserved
              for TITA, with rating still choosing <em>which</em> TITA. That
              holds ~33% at every rating, close to CAT&apos;s own ~36%. The quota
              lives in exactly one function so it can&apos;t drift between the
              match, challenge, and practice paths — a lesson learned when the
              practice drill silently served zero TITA across five sessions for
              precisely this reason.
            </P>
            <Note title="TITA answers are numeric, and the input box is the enforcement">
              We measured what the answer matcher accepts:{" "}
              <Code>1900</Code>, <Code>1,900</Code>, <Code>1900.0</Code>,{" "}
              <Code>+1900</Code>, <Code>1.9e3</Code> all match — and{" "}
              <Code>Rs.1900</Code> and <Code>1900 metres</Code> do not. So a
              player who solved correctly and typed the unit scored zero. The
              tempting fix — strip non-numeric characters — is dangerous:
              stripping turns <Code>Rs.1900</Code> into <Code>.1900</Code>, and
              stripping a minus sign marks <Code>−3</Code> correct against a key
              of <Code>3</Code>. That doesn&apos;t soften a wrong answer, it
              marks wrong answers <em>right</em>. So the matcher stays strict, a
              database constraint forces every TITA key to be numeric, and the
              answer box rejects the non-numeric keystroke rather than sanitising
              it after the fact — which is also exactly what the real CAT
              interface does. What the player sees is always what gets scored.
            </Note>
          </Section>

          {/* ── Realtime ── */}
          <Section id="realtime" n="09" title="Realtime transport">
            <P>
              Three realtime primitives are used, and the split between them is a
              trust boundary rather than a performance choice.
            </P>
            <Table
              head={["Primitive", "Carries", "Trust"]}
              rows={[
                [
                  "Postgres Changes",
                  "Match state, queue status",
                  "Authoritative — it is the database row.",
                ],
                [
                  "Broadcast",
                  "\"opponent answered\" liveness pings",
                  "Untrusted. Never carries a score or a correctness flag.",
                ],
                [
                  "Presence",
                  "Who is in the match / global online count",
                  "A hint. Presence loss starts a timer; only the server can forfeit.",
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
              Spectators subscribe to a broadcast-only channel and are
              deliberately excluded from presence, so an audience arriving or
              leaving can never influence the forfeit logic of the players below.
            </P>
            <P>
              And because realtime is a transport rather than a source of truth,
              every client rehydrates from the database on reconnect, on channel
              error, and on the browser&apos;s <Code>online</Code> event. A
              dropped message costs a render, never a state divergence. A polling
              fallback backstops the queue for the case where the realtime
              publication doesn&apos;t cover a table at all — which is exactly
              how friend challenges work today.
            </P>
          </Section>

          {/* ── Anti-cheat ── */}
          <Section id="anticheat" n="10" title="Anti-cheat">
            <P>
              Rating is only worth defending if it is hard to fake. The defences
              are layered, and each one closes a hole we actually found.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Per-player option shuffling
            </h3>
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
              to canonical, and the one that maps the canonical correct answer
              back to display for the reveal. A migration once recreated two of
              them from a pre-shuffle copy and silently desynced scoring —
              correct answers marked wrong, no error anywhere. There is now a
              dedicated invariant test that fails if the three ever disagree.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Row-level isolation of answers
            </h3>
            <P>
              Answer rows are readable by their <em>owner only</em>. The obvious
              policy — participants of the match can read the match&apos;s
              answers — leaked in a way that took a second look to see: with TITA,
              the typed answer is stored as plaintext, so whoever answered first
              handed the other player the answer while the question was still
              open. Every opponent-facing read (reveal, debrief, spectator view)
              goes through a definer function that applies its own timing rules,
              so tightening the policy cost nothing.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Clock synchronisation
            </h3>
            <P>
              The client renders a countdown, but it renders it against a
              measured offset from server time, sampled at the midpoint of the
              request so it corrects for absolute clock skew rather than just
              round-trip latency. At zero the client auto-submits a null. The
              display is a convenience; the server&apos;s own timestamp is what
              scores.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Behavioural telemetry
            </h3>
            <P>
              Clients may report exactly two events —{" "}
              <Code>tab_hidden</Code> and <Code>window_blur</Code> — from a
              server-side whitelist, rate-limited. The server adds its own signal
              the client can neither see nor suppress: <Code>fast_answer</Code>,
              recorded whenever a correct answer arrives in under two seconds.
              Alone each is noise; correlated across a match they are a
              legible pattern, surfaced to an internal review query.
            </P>
          </Section>

          {/* ── Ninja AI ── */}
          <Section id="ninja" n="11" title="The Ninja AI layer">
            <P>
              Ninja AI is the coaching layer: a stat-grounded chat coach, a
              Socratic hint mode, per-match debriefs, a daily focus line, a
              seven-day study plan, and a PDF solver. Six user-facing routes,
              each doing its own authentication, its own per-user and per-IP
              rate limiting, and its own guard checks inline.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              The rule that shapes everything: no LLM while you are playing
            </h3>
            <P>
              An AI that can solve CAT questions, inside a product where solving
              CAT questions faster than another human is the entire point, is a
              cheating engine unless it is gated. So every user-facing AI route
              is blocked while the caller is in a live match.
            </P>
            <P>
              The important detail is <em>what the gate keys on</em>. It keys on
              the caller, not on the match the request names. Each per-match
              guard only inspects the match in its own arguments — so mid-match,
              a request pointed at an <em>old, completed</em> match passes those
              guards untouched. Second tab, live match running, LLM solving
              questions. The two mechanisms are not redundant copies of each
              other; they stop different attacks, and neither can be removed as
              duplicate.
            </P>
            <P>
              The gate fails closed: if the check itself errors, the call is
              blocked. The widest holes were the routes taking arbitrary input —
              the chat coach (paste the live question) and the PDF solver
              (screenshot it into a document). The daily-focus route takes no
              input and isn&apos;t a cheat channel at all, but it rides the same
              rule so there is exactly one definition of &quot;live&quot; in the
              codebase — the same one matchmaking uses.
            </P>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Cost engineering
            </h3>
            <P>
              LLM calls are the only unbounded-cost operation in the product, and
              they are treated as a resource to be budgeted rather than a
              feature to be sprinkled.
            </P>
            <Table
              head={["Operation", "Cost per call", "Control"]}
              rows={[
                ["Question explanation", "$0.001 – $0.005", "3 attempts per question, checked before spending"],
                ["Match debrief", "~$0.0014", "Cached per match, first write wins — a re-read never re-bills"],
                ["Daily focus", "~$0.0008", "One per day, cached"],
                ["Coach chat turn", "$0.007 – $0.043", "Agentic; cost grows quadratically in turn count"],
                ["Study plan", "~$0.002", "Regeneration capped at once a week, enforced in the database"],
                ["PDF solve", "$0.06 – $0.31", "Most expensive user action in the product"],
              ]}
            />
            <List
              items={[
                <>
                  <strong className="text-white">Attempt ceilings are pre-spend.</strong>{" "}
                  The three-explanations-per-question cap is checked before the
                  model is called, not after. It is the only reason a
                  fifteen-per-minute rate limit is financially safe.
                </>,
                <>
                  <strong className="text-white">Caches are cost controls.</strong>{" "}
                  Debriefs, daily focus, and study plans are stored on first
                  write. Re-reading is free forever. They look like conveniences
                  and are actually the billing model.
                </>,
                <>
                  <strong className="text-white">The coach&apos;s data is bounded in app code.</strong>{" "}
                  The agentic coach replays every prior tool result at each of up
                  to six reasoning steps, so an unbounded rating history costs
                  tokens quadratically in conversation length <em>and</em>{" "}
                  linearly in career length. The rating curve handed to the model
                  is capped at 30 points — measured, that is 16,590 → 2,658
                  tokens per turn for a 200-match player, and 82,590 → 2,658 at
                  1,000 matches. Deliberately <em>not</em> fixed in SQL: the
                  profile graph legitimately wants the whole curve. The bug was
                  only ever in handing it to a language model. And the trim takes
                  the tail, because taking the head would feed the model a stale
                  trend and silently invert the advice — a rising player read as
                  sliding.
                </>,
                <>
                  <strong className="text-white">Learning without per-match inference.</strong>{" "}
                  The coach&apos;s knowledge of a player comes from a
                  bounded-by-construction aggregate — three sections × two
                  question types × three rating bands, plus one trend object —
                  computed in SQL. Every match teaches the coach something and no
                  match costs an LLM call. Timeouts are excluded from accuracy
                  rates rather than counted as skips, and season-reset markers
                  are excluded from the trend.
                </>,
              ]}
            />

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              Reasoning tokens are a budgeting hazard
            </h3>
            <P>
              The production model emits reasoning tokens. They bill as
              completion <em>and</em> consume the output budget{" "}
              <strong className="text-white">before any answer text exists</strong>
              . Measured: a trivial arithmetic prompt spent 83 of 108 completion
              tokens on reasoning; a real Quant solve spent 224 of 417. At a
              300-token cap the response content came back <em>null</em> — not an
              error, not a truncation warning, just empty.
            </P>
            <P>
              So output caps are never sized to the visible answer. Routes that
              need one short line still request a large budget and truncate
              afterward. The model fallback exists specifically for this failure
              mode — the upstream gateway already load-balances across 28
              providers, so availability is not what a fallback buys. It only
              helps if the retry loop treats <em>empty text</em> as a failure
              rather than a success, which one route did not, leaving its
              fallback as dead code until we measured it.
            </P>
          </Section>

          {/* ── Embeddings ── */}
          <Section id="embeddings" n="12" title="Vector search over the question bank">
            <P>
              Every question in the bank carries a 1536-dimensional embedding in
              a pgvector column, backfilled by a single idempotent writer that
              selects only rows with a null embedding — which makes re-running it{" "}
              <em>the</em> repair path rather than a risk.
            </P>
            <P>
              Staleness is handled by a database trigger, not by caller
              discipline: any real change to a question body nulls its embedding,
              from any writer, including ones that don&apos;t exist yet. The
              trigger is scoped so it never fires on the rating and
              times-seen updates that the match hot path performs.
            </P>
            <Note title="Similarity search is a bank-scraping oracle if you let it">
              The search function returns <strong className="text-white">ids and
              similarity scores only, never question bodies</strong>, and is
              granted to the service role alone. Even without bodies, a
              similarity score against caller-supplied text is a &quot;how close
              is my guess?&quot; oracle — enough to reconstruct the bank with
              patience. So the design rule written next to it is that any future
              consumer must pass a server-derived vector, never caller-supplied
              text. It is also worth knowing that Supabase&apos;s default
              privileges grant execute on every new function to authenticated
              users, so revoking public and anon alone leaves that standing.
            </Note>

            <h3 className="font-pixel text-lg mt-8 mb-3 text-[#ffd166]">
              A 140× storage lesson
            </h3>
            <P>
              pgvector defaults vector columns to EXTERNAL storage, which pushes
              every 6KB embedding into TOAST — so an exact scan pays a detoast
              per row. Measured at 1,247 rows: 677ms and 7,693 buffers TOASTed,
              versus 4.8ms and 1,372 buffers inline.
            </P>
            <P>
              Two traps in the fix. First, altering the storage mode only governs
              rows written <em>after</em> the alter, so the existing bank stays
              TOASTed and the improvement never materialises. Second — and this
              one is genuinely subtle —{" "}
              <Code>update questions set embedding = embedding</Code> is a{" "}
              <strong className="text-white">silent no-op</strong>: assigning a
              column to itself passes the same TOAST pointer through, Postgres
              sees an unchanged external datum, and never re-toasts it. Forcing a
              fresh datum requires a round trip through the type:{" "}
              <Code>embedding = (embedding::text)::vector(1536)</Code>, verified
              lossless across all rows before it was run.
            </P>
            <P>
              There is no HNSW index. At this bank size the exact scan is fast
              enough and has no recall loss — an approximate index would be
              complexity bought with accuracy, for a latency win nobody would
              feel.
            </P>
          </Section>

          {/* ── Data ── */}
          <Section id="data" n="13" title="Data model & Row-Level Security">
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
                  "The bank is the product. It is served only through definer functions that strip keys.",
                ],
                [
                  "match_answers",
                  "Own rows only",
                  "Participant-scope leaked the opponent's live TITA answer text.",
                ],
                [
                  "profiles",
                  "World-readable; rating and stats frozen from client UPDATE",
                  "Public profiles are a feature; self-set rating is not.",
                ],
                [
                  "friendships, telemetry, rate limits",
                  "RLS on, zero policies",
                  "Reachable exclusively through definer functions. Deny by default.",
                ],
                [
                  "waitlist",
                  "Validated anon INSERT only",
                  "INSERT-not-UPDATE means a resubmit can never overwrite an existing row.",
                ],
                [
                  "avatars (storage)",
                  "Writes scoped to the uploader's own folder",
                  "Path-prefix check on the authenticated user id.",
                ],
              ]}
            />
            <P>
              Every policy wraps the auth-uid call as a scalar subquery. That
              single syntactic detail moves it into the query&apos;s InitPlan so
              it evaluates once per query instead of once per row — a
              linear-to-constant improvement on any policy-covered scan, and one
              the Supabase linter flags if it drifts back.
            </P>
            <P>
              Definer functions carry their own discipline: an explicit search
              path pinned inline on each function (a blanket pin is dropped the
              moment anything replaces the function), execute revoked from public
              and anon, then granted explicitly to the roles that need it.
              Read-only public functions — leaderboard, profiles — stay
              anon-callable on purpose so logged-out pages can be cached.
            </P>
            <Note title="Migration discipline, learned expensively">
              Three separate production regressions came from the same cause:{" "}
              <Code>CREATE OR REPLACE</Code> written from a stale copy of a
              function, silently reverting a fix. A fourth came from a related
              trap —{" "}
              <strong className="text-white">
                adding a parameter is not a replace, it is a new overload
              </strong>
              . The old two-argument function stays alive beside the new
              three-argument one, and an exact-arity call binds to the old one:
              no error, plausible results, and a fixed exploit quietly back in
              production. The standing rules are now to always start from the
              latest definition, to drop-and-create whenever a signature grows,
              and to verify afterward that exactly one candidate function
              remains.
            </Note>
          </Section>

          {/* ── Rate limiting ── */}
          <Section id="limits" n="14" title="Rate limiting">
            <P>
              Two independent durable layers, both backed by Postgres tables
              rather than process memory — an in-memory limiter is per-instance,
              and serverless instances multiply.
            </P>
            <List
              items={[
                <>
                  <strong className="text-white">Per-user, inside the RPC.</strong>{" "}
                  The check is the first statement of the function and{" "}
                  <em>raises</em> on exceed, so the limit and the operation share
                  one transaction and cannot be raced apart.
                </>,
                <>
                  <strong className="text-white">Per-IP, at the route handler.</strong>{" "}
                  Returns a retry-after rather than throwing, and{" "}
                  <em>fails open</em> on infrastructure error — deliberately, for
                  unauthenticated endpoints where a limiter outage must not
                  become an outage.
                </>,
                <>
                  <strong className="text-white">The metered AI routes fail closed.</strong>{" "}
                  Opposite decision, opposite reason: fail-open on a route that
                  costs real money per call is a billing incident.
                </>,
              ]}
            />
            <P>
              The API routes sit outside the auth proxy&apos;s matcher entirely,
              which is a deliberate architectural fact rather than an oversight —
              and it means each handler is fully responsible for its own
              authentication, its own gating, and its own limits. That is the
              only thing standing between a public domain and the most expensive
              call in the product.
            </P>
          </Section>

          {/* ── Performance ── */}
          <Section id="perf" n="15" title="Performance">
            <List
              items={[
                <>
                  <strong className="text-white">Local JWT verification in the auth proxy.</strong>{" "}
                  Claims are verified locally against asymmetric signing keys
                  instead of making an auth-server round trip on{" "}
                  <em>every single request</em>. This is the single largest
                  per-request cost reduction in the app.
                </>,
                <>
                  <strong className="text-white">The onboarding gate costs one lookup per session.</strong>{" "}
                  A completed profile is cached in a cookie, so the database
                  check happens at most once rather than on every authed
                  navigation — which is what keeps the optimisation above from
                  being immediately undone.
                </>,
                <>
                  <strong className="text-white">Public pages are cookieless and cached.</strong>{" "}
                  The leaderboard and profiles render through a session-less
                  client with incremental static regeneration.
                  &quot;You&quot;-highlighting is resolved client-side
                  specifically so the page itself stays cacheable for everyone.
                </>,
                <>
                  <strong className="text-white">Authed pages are never bfcached.</strong>{" "}
                  A no-store header on authenticated responses, because the
                  browser&apos;s Back button restores the last rendered page{" "}
                  <em>without re-running middleware</em> — which after logout
                  means an authed screen on screen.
                </>,
                <>
                  <strong className="text-white">Foreign keys are indexed.</strong>{" "}
                  Nine were added in one hardening pass after the linter flagged
                  them; unindexed FKs turn every cascading delete into a
                  sequential scan.
                </>,
              ]}
            />
          </Section>

          {/* ── Cron ── */}
          <Section id="cron" n="16" title="Scheduled jobs">
            <P>
              Three cron jobs run inside Postgres. No external scheduler, no
              worker fleet.
            </P>
            <Table
              head={["Job", "Cadence", "Work"]}
              rows={[
                [
                  "Timeout drain",
                  "Every minute",
                  "Abandons no-shows, writes skip rows for expired questions against each player's own clock, advances or finalises.",
                ],
                [
                  "Queue sweep",
                  "Every minute",
                  "Cancels waiting rows whose heartbeat is more than 90 seconds stale; prunes finished rows older than a day.",
                ],
                [
                  "Season rollover",
                  "Hourly",
                  "Snapshots standings, applies the soft rating reset, writes reset markers into rating history.",
                ],
              ]}
            />
            <P>
              The timeout drain writes its skip rows with a null elapsed time.
              That null is not missing data — it is the marker distinguishing a
              cron-written timeout from a genuine client submission, which always
              records a duration. Several downstream systems key on it: forfeit
              evidence, debrief accuracy, and the coach&apos;s learner profile,
              which excludes timeouts from accuracy rates rather than counting
              them as deliberate skips.
            </P>
          </Section>

          {/* ── Testing ── */}
          <Section id="testing" n="17" title="How the invariants are verified">
            <P>
              Game-critical logic is verified by SQL harnesses that run inside a
              transaction and roll back — real rows, real functions, real
              constraints, no residue. They assert the properties, not the
              implementations:
            </P>
            <List
              items={[
                <>
                  Rating transfers are strictly zero-sum, and never breach the
                  floor.
                </>,
                <>
                  Guessing is EV-neutral, at every point on the time curve and at
                  every option count.
                </>,
                <>
                  The three option-shuffle functions agree — the specific
                  regression that once shipped silently.
                </>,
                <>
                  Exactly one time-cap source is consulted by every function in a
                  match context, so timers cannot desync.
                </>,
                <>
                  Self-paced progression: each player advances independently, and
                  the match finalises only when both hold nine answers.
                </>,
                <>
                  Every user-facing AI route is blocked mid-match, including
                  when it points at an unrelated completed match.
                </>,
              ]}
            />
            <P>
              Alongside them: a deterministic Monte-Carlo simulation backing the
              question-rating constants, a zero-network self-test for the
              prompt-construction branches, a self-test for the coach&apos;s
              token cap that asserts both the cap <em>and</em> that the trim
              takes the tail, and a live end-to-end probe that spends about
              $0.004 to grade a real model answer against a real key.
            </P>
          </Section>

          {/* ── Deploy ── */}
          <Section id="deploy" n="18" title="Deployment topology">
            <P>
              One repository builds two production Vercel projects from the same
              branch, differing only by environment variable. The public
              waitlist site and the full battle app are, by construction, the
              identical commit — the front door is chosen by one variable at
              runtime, not by a code branch or a long-lived release branch.
            </P>
            <P>
              That means the launch is the removal of one environment variable:
              no deploy, no merge, no migration. It also means an accidental
              deletion of that variable launches the product, which is precisely
              the kind of fact that belongs written down rather than discovered.
            </P>
            <P>
              An earlier setup used a build-ignore guard to freeze the public
              site while the trunk moved. It was deleted once both domains were
              meant to track the trunk — a guard permanently defeatable by an
              environment variable, and invisible in the repository, is worse
              than no guard, because it is exactly the failure it was written to
              prevent.
            </P>
          </Section>

          {/* ── Numbers ── */}
          <Section id="numbers" n="19" title="The numbers">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              {[
                ["104", "migrations"],
                ["95", "Postgres functions"],
                ["3,100+", "questions, all embedded"],
                ["9", "questions per match"],
                ["140", "max points / question, every section"],
                ["1,000", "starting rating"],
                ["2s", "fast-answer exclusion floor"],
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

          {/* Closing */}
          <div className="mt-20 rounded-2xl border border-[#06d6a0]/25 bg-[#111111] px-8 py-12 text-center">
            <h2 className="font-pixel text-[clamp(1.5rem,3vw,2.2rem)] leading-tight mb-4">
              Every rating on the board was earned against this.
            </h2>
            <p className="text-[#c5e8f0]/70 text-base max-w-[46ch] mx-auto mb-8">
              Server-scored, per-player-shuffled, rate-limited, and impossible to
              fake from a browser console.
            </p>
            <Link
              href="/auth/signup"
              className="inline-flex items-center justify-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-7 py-3 hover:bg-[#05b088] transition-colors"
            >
              Enter the arena →
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ── Presentational helpers ─────────────────────────────────────────── */

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

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[#c5e8f0]/75 text-[15px] leading-[1.75] mb-5 max-w-[68ch]">
      {children}
    </p>
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
        <li key={i} className="flex gap-3 text-[#c5e8f0]/75 text-[15px] leading-[1.75]">
          <span className="text-[#06d6a0] mt-[0.45rem] shrink-0 w-1.5 h-1.5 rounded-full bg-[#06d6a0]" />
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
      <table className="w-full min-w-[540px] text-left border-collapse">
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
            <tr key={i} className="border-b border-[#1a1a1a] last:border-0 align-top">
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
      d: "Matchmaking, scoring, rating math, timeouts, and seasons — all inside security-definer functions with RLS underneath.",
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
          <div
            className="font-pixel text-sm mb-2"
            style={{ color: l.c }}
          >
            {l.n}
          </div>
          <p className="text-[#c5e8f0]/60 text-[13px] leading-relaxed">{l.d}</p>
        </div>
      ))}
    </div>
  );
}
