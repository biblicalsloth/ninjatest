import type { Metadata } from "next";
import Link from "next/link";
import { NinjatestLogo } from "@/components/ninja-logo";

export const metadata: Metadata = {
  title: "Changelog — Ninjatest",
  description:
    "What shipped, when, and why — every notable change to the Ninjatest arena, question bank, and Ninja AI layer.",
};

// ponytail: pure server component, same as /docs — prose + anchors need no JS.
// Entries are hand-curated from the commit history; a build-time git parse would
// leak internal refactors into a user-facing page.

type Kind = "added" | "fixed" | "changed" | "removed";

const KIND: Record<Kind, { label: string; fg: string; bg: string; bd: string }> = {
  added:   { label: "Added",   fg: "#06d6a0", bg: "rgba(6,214,160,0.10)",  bd: "rgba(6,214,160,0.22)" },
  fixed:   { label: "Fixed",   fg: "#7ab5cc", bg: "rgba(122,181,204,0.10)", bd: "rgba(122,181,204,0.22)" },
  changed: { label: "Changed", fg: "#ffd166", bg: "rgba(255,209,102,0.09)", bd: "rgba(255,209,102,0.22)" },
  removed: { label: "Removed", fg: "#ef476f", bg: "rgba(239,71,111,0.09)",  bd: "rgba(239,71,111,0.22)" },
};

type Entry = { kind: Kind; title: string; body: string };
type Release = { date: string; label: string; tag?: string; entries: Entry[] };

const RELEASES: Release[] = [
  {
    date: "2026-07-26",
    label: "Pricing, in the house style",
    entries: [
      {
        kind: "changed",
        title: "Pricing page adopts the landing aesthetic",
        body:
          "The pricing page now runs the same near-black violet field and animated gradient layer as the landing page, with mint as its only call-to-action colour. It used to sit on a standalone green background with gold buttons, which read as a different product.",
      },
    ],
  },
  {
    date: "2026-07-20",
    label: "Settings polish",
    entries: [
      {
        kind: "fixed",
        title: "Settings nav highlights the section you clicked",
        body:
          "Scroll-spy alone fought your click near the bottom of the page, where short sections can never reach the top of the viewport. A click now wins until you scroll again.",
      },
    ],
  },
  {
    date: "2026-07-19",
    label: "Motion, settings, and a leaner surface",
    entries: [
      {
        kind: "added",
        title: "One motion vocabulary across every screen",
        body:
          "Results stamp in, lists rise on a shared easing curve, and page transitions are consistent app-wide. Everything respects prefers-reduced-motion: the animation is skipped, never the content.",
      },
      {
        kind: "added",
        title: "Card-based settings with local preference toggles",
        body:
          "Display name, password, and avatar sit in their own cards alongside preferences that stay on your device.",
      },
      {
        kind: "added",
        title: "Practice history and drill-your-misses",
        body:
          "Every solo drill is archived, and questions you got wrong can be re-served as a targeted set. Season resets are marked on the rating graph so a soft reset never reads as a collapse.",
      },
      {
        kind: "added",
        title: "Exam picker after login",
        body:
          "New accounts choose their target exam before landing in the lobby.",
      },
      {
        kind: "fixed",
        title: "Friend challenges work end to end",
        body:
          "Accepting an invite link now carries you through sign-in, the host is notified without waiting on a realtime channel that never carried challenges, and a challenge code can be joined directly.",
      },
      {
        kind: "fixed",
        title: "Matches recover from a dropped submit",
        body:
          "A retry after a lost connection re-derives your true position instead of resubmitting a stale question index, so a flaky network can no longer strand you mid-match.",
      },
      {
        kind: "fixed",
        title: "Bot matches start from the lobby",
        body:
          "Playing the bot no longer requires an existing queue row.",
      },
      {
        kind: "removed",
        title: "Admin console",
        body:
          "The in-app admin console and its API routes are gone. Question-bank work moved to the ingest scripts, shrinking the authenticated attack surface.",
      },
    ],
  },
  {
    date: "2026-07-18",
    label: "Self-paced matches",
    tag: "Milestone",
    entries: [
      {
        kind: "changed",
        title: "Each player runs their own clock",
        body:
          "Matches were lockstep: both players waited on the slower one at every question. Now each player traverses their own nine questions at their own pace, and the match is decided once both have finished. Bot matches deliberately stay lockstep.",
      },
      {
        kind: "added",
        title: "DILR bank with diagrams and shared caselets",
        body:
          "Data-interpretation sets are served whole — the caselet and its sub-questions together — with the reading window added to the first question's clock instead of being charged against your speed bonus.",
      },
      {
        kind: "added",
        title: "Ninja learns from every match",
        body:
          "A rolling profile of your accuracy by section, question type, and difficulty band feeds the coach with no extra model call per match.",
      },
      {
        kind: "fixed",
        title: "A match can never be short of nine questions",
        body:
          "If one section is thin, its slots are redistributed rather than producing a truncated match that could run past its own question list.",
      },
    ],
  },
  {
    date: "2026-07-17",
    label: "Ninja AI, TITA, and practice drills",
    tag: "Milestone",
    entries: [
      {
        kind: "added",
        title: "Ninja coach chat, PDF solver, and study plans",
        body:
          "Three modes on one route: stat-grounded Q&A, a Socratic buddy that gives hints rather than solutions, and a seven-day plan. Plus a PDF solver that reads a question paper you upload.",
      },
      {
        kind: "added",
        title: "Type-in-the-answer questions",
        body:
          "TITA questions ship across matches and solo drills. The answer box accepts numbers only — the same constraint the real exam interface applies — because a lenient matcher would turn a correct answer with a unit attached into a wrong one.",
      },
      {
        kind: "added",
        title: "Solo practice drills with explanations",
        body:
          "Weakest-section-first question selection, unrated, with the worked explanation revealed the moment you lock an answer. Practice never moves your rating and never touches question difficulty.",
      },
      {
        kind: "changed",
        title: "No AI of any kind while you are in a match",
        body:
          "Every Ninja route refuses to answer while the caller has a live match — including questions aimed at an older, finished match from a second tab. The rule keys on you, not on the match you name.",
      },
      {
        kind: "added",
        title: "Semantic search over the question bank",
        body:
          "Questions carry embeddings, refreshed automatically whenever a question body changes. The search primitive returns identifiers and similarity only, never question text.",
      },
    ],
  },
  {
    date: "2026-07-16",
    label: "Ladder integrity",
    entries: [
      {
        kind: "fixed",
        title: "Your opponent's answer stays private until you have answered",
        body:
          "Answer rows are readable only by their own author. Previously a typed answer could be read by the other player while the question was still open — with type-in answers stored as plain text, that handed over the answer.",
      },
      {
        kind: "fixed",
        title: "The bot is excluded from both leaderboards",
        body: "Ninja Bot no longer appears on the global ladder or in season results.",
      },
      {
        kind: "changed",
        title: "Question difficulty only learns from rated and bot matches",
        body:
          "Unrated player-versus-player matches no longer nudge a question's difficulty rating — uncapped private challenges were a way for two accounts to distort the bank together.",
      },
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <nav className="px-6 sm:px-10 py-5 flex items-center justify-between border-b border-[#1e1a26] sticky top-0 z-30 bg-[#120F17]/95 backdrop-blur">
        <Link href="/">
          <NinjatestLogo />
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/docs" className="text-white/45 hover:text-white text-sm transition-colors">
            Docs
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
              Releases
            </p>
            <ul className="space-y-2 border-l border-[#222222] pl-4">
              {RELEASES.map((r) => (
                <li key={r.date}>
                  <a
                    href={`#${r.date}`}
                    className="text-white/45 hover:text-[#06d6a0] text-[13px] leading-snug transition-colors block"
                  >
                    <span className="font-mono text-[11px] text-white/30 block">{r.date}</span>
                    {r.label}
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
              Product / Changelog
            </p>
            <h1 className="font-pixel text-[clamp(2.2rem,4.6vw,3.6rem)] leading-[1.04] text-balance">
              What shipped, and{" "}
              <span className="text-[#06d6a0]">why</span>
            </h1>
            <p className="mt-7 text-[#c5e8f0]/75 text-lg font-light leading-relaxed max-w-[62ch]">
              Every notable change to the arena, the question bank, and the Ninja
              AI layer — newest first. Fixes get the same billing as features:
              on a rated ladder, a quiet correctness bug is the more expensive
              of the two.
            </p>
            <p className="mt-5 text-[#c5e8f0]/60 text-base font-light leading-relaxed max-w-[62ch]">
              For how any of it actually works, read the{" "}
              <Link href="/docs" className="text-[#06d6a0] hover:underline">
                architecture docs
              </Link>
              .
            </p>
          </header>

          {RELEASES.map((r) => (
            <section key={r.date} id={r.date} className="mb-16 scroll-mt-24">
              <div className="flex flex-wrap items-baseline gap-3 mb-2">
                <time className="font-mono text-xs text-white/35 tabular-nums">{r.date}</time>
                {r.tag && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#06d6a0] bg-[#06d6a0]/10 border border-[#06d6a0]/25 rounded-full px-2.5 py-0.5">
                    {r.tag}
                  </span>
                )}
              </div>
              <h2 className="font-pixel text-[clamp(1.4rem,2.6vw,2rem)] leading-tight mb-7">
                {r.label}
              </h2>

              <ul className="space-y-5 border-l border-[#222222] pl-6 max-w-[68ch]">
                {r.entries.map((e) => {
                  const k = KIND[e.kind];
                  return (
                    <li key={e.title} className="relative">
                      <span
                        className="absolute -left-[1.93rem] top-[0.55rem] w-1.5 h-1.5 rounded-full"
                        style={{ background: k.fg }}
                      />
                      <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                        <span
                          className="font-mono text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-0.5"
                          style={{ color: k.fg, background: k.bg, border: `1px solid ${k.bd}` }}
                        >
                          {k.label}
                        </span>
                        <span className="text-white/90 text-[15px] font-medium">{e.title}</span>
                      </div>
                      <p className="text-[#c5e8f0]/65 text-[14.5px] leading-[1.75]">{e.body}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          <p className="text-white/30 text-[13px] font-mono border-t border-[#1e1a26] pt-8">
            Ninjatest opened its repository on 2026-07-16. Anything before that
            predates version control on this codebase.
          </p>
        </main>
      </div>
    </div>
  );
}
