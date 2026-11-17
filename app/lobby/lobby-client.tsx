"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  AnimatePresence, MotionConfig, motion, useReducedMotion, useSpring, useTransform, type Variants,
} from "motion/react";
import { LineChart, Line, ResponsiveContainer, ReferenceLine, YAxis } from "recharts";
import { Zap, Users, Target, Bot, Eye, Trophy, Flame, ArrowUpRight } from "lucide-react";
import { useOnlineCount } from "@/lib/hooks/use-online-count";
import { createClient } from "@/lib/supabase/client";
import { ChallengeDialog } from "@/components/challenge-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Profile } from "@/lib/supabase/types";
import type { StudyPlan } from "@/lib/ai/model";
import { PLAN_DAYS } from "@/lib/ai/model";
import { cn, getWinRate } from "@/lib/utils";
import { getLeague } from "@/lib/leagues";
import { gsap, useGSAP, countTo, prefersReduced } from "@/lib/motion";
import { StudyTimeline, todayIndex, SECTION_LOOK } from "./study-timeline";

// Palette ("tuned to mint"): pastel cards on the dark #120F17 page, dark ink on
// top. Mint stays the only CTA colour. Each card also carries a deeper tone of
// its own hue for the decorative shape bleeding off its corner.
const C = {
  ink: "#17131C",
  mint: "#06d6a0", mintTone: "#05b088",
  butter: "#F5D96B", butterTone: "#EBC53E",
  rose: "#F7BFD8", roseTone: "#EE9EC3",
  sage: "#B7C97A", sageTone: "#9DB35A",
  peri: "#A9BDF2", periTone: "#8AA4EA",
} as const;

export interface SectionStat { section: "VARC" | "DILR" | "QUANT"; questions_answered: number; accuracy: number | null }
export interface RecentMatch {
  match_id: string; opponent: string; opponent_avatar: string | null;
  my_score: number; opp_score: number; result: string; elo_delta: number | null; played_at: string;
}
interface DailyProgress { matches_today: number; wins_today: number }

interface Props {
  profile: Profile;
  dailyProgress: DailyProgress;
  sectionStats: SectionStat[];
  recentMatches: RecentMatch[];
  eloCurve: number[];
  plan: StudyPlan | null;
  weekStart: string | null;
  regens: number;
}

const SPRING = { type: "spring", stiffness: 300, damping: 24 } as const;
const container: Variants = { show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } } };
const rise: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 220, damping: 24 } },
};

export default function LobbyClient({
  profile, dailyProgress, sectionStats, recentMatches, eloCurve, plan, weekStart, regens,
}: Props) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [startingBot, setStartingBot] = useState(false);
  const [showChallenge, setShowChallenge] = useState(false);
  const displayName = profile.display_name ?? profile.username;

  async function handleFindMatch() {
    if (joining) return;
    setJoining(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("join_queue");
    if (error) {
      toast.error("Failed to join queue: " + error.message);
      setJoining(false);
      return;
    }
    router.push("/queue");
  }

  async function handlePlayBot() {
    if (startingBot) return;
    setStartingBot(true);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("match_with_bot");
    if (error || !data) {
      toast.error("Bot unavailable right now — try again");
      setStartingBot(false);
      return;
    }
    router.push(`/match/${data}`);
  }

  const winRate = getWinRate(profile.wins, profile.matches_played);
  const league = getLeague(profile.elo);

  // Greeting + today's task count depend on the viewer's clock — computed after
  // mount so server HTML (UTC) can't mismatch.
  const [greeting, setGreeting] = useState("Welcome");
  const [tasksToday, setTasksToday] = useState<number | null>(null);
  useEffect(() => {
    const h = new Date().getHours();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGreeting(h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
    const i = todayIndex(weekStart);
    if (plan && i >= 0) setTasksToday((plan.days[PLAN_DAYS[i]] ?? []).filter((t) => t.section !== "REST").length);
  }, [plan, weekStart]);

  // Odometer roll on numeric stats (GSAP vocabulary from lib/motion.ts).
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (prefersReduced()) return;
      gsap.utils.toArray<HTMLElement>("[data-countup]").forEach((el) => {
        const to = parseInt(el.textContent ?? "0", 10);
        if (!Number.isNaN(to)) countTo(el, 0, to, { delay: 0.3 });
      });
    },
    { scope }
  );

  const stat = (s: SectionStat["section"]) => sectionStats.find((x) => x.section === s);
  const first = eloCurve[0] ?? profile.elo;
  const trendDelta = profile.elo - first;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={scope} className="min-h-screen bg-[#120F17] text-white">
        <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-8 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* ═════════ Main column ═════════ */}
          <motion.main variants={container} initial="hidden" animate="show" className="min-w-0 space-y-5">
            <motion.header variants={rise} className="flex items-start justify-between gap-4 pt-2">
              <div className="min-w-0">
                <h1 className="font-pixel text-3xl leading-tight break-words md:text-4xl">
                  {greeting}, <span className="text-[#06d6a0]">{displayName}</span>
                </h1>
                <p className="mt-2 max-w-xl text-sm text-white/55">
                  {tasksToday
                    ? `Ninja has ${tasksToday} task${tasksToday > 1 ? "s" : ""} on today's plan.`
                    : "Sharpen up — every battle moves your rating."}
                  {profile.current_streak >= 2 && ` You're on a ${profile.current_streak}-win streak.`}
                </p>
              </div>
              <OnlinePill userId={profile.id} />
            </motion.header>

            {/* ── Play (mint, full width) ── */}
            <PastelCard
              color={C.mint}
              shape={<Shuriken color={C.mintTone} className="-right-10 -top-14 h-56 w-56" spin />}
              className="p-6"
            >
              <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p className="font-pixel text-sm opacity-70">Play</p>
                  <motion.button
                    whileHover={{ x: 4 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={handleFindMatch}
                    disabled={joining}
                    className="mt-1 flex items-center gap-3 text-left disabled:opacity-70"
                  >
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#17131C] text-[#06d6a0]">
                      <Zap size={22} fill="currentColor" />
                    </span>
                    <span>
                      <span className="block whitespace-nowrap font-pixel text-2xl md:text-3xl">{joining ? "Joining queue…" : "Ranked 1v1"}</span>
                      <span className="block text-sm opacity-70">Mixed 3·3·3 · ELO rated</span>
                    </span>
                  </motion.button>
                </div>
                <div className="flex flex-wrap gap-2 xl:max-w-[420px] xl:justify-end">
                  <ModePill icon={<Users size={14} />} onClick={() => setShowChallenge(true)}>Challenge</ModePill>
                  <ModePill icon={<Target size={14} />} href="/practice">Practice</ModePill>
                  <ModePill icon={<Bot size={14} />} onClick={handlePlayBot} disabled={startingBot}>
                    {startingBot ? "Starting…" : "Vs Bot"}
                  </ModePill>
                  <ModePill icon={<Eye size={14} />} href="/spectate">Spectate</ModePill>
                  <ModePill icon={<Trophy size={14} />} href="/leaderboard">Leaderboard</ModePill>
                </div>
              </div>
            </PastelCard>

            {/* ── 4 pastel stat cards (zig-zag widths like the ref) ── */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-5">
              <PastelCard color={C.butter} shape={<Crown color={C.butterTone} className="-right-8 -top-6 h-40 w-40" />} className="sm:col-span-2">
                <CardTitle>Rating:</CardTitle>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <Metric value={profile.elo} label="Current" big countup />
                  <Metric value={profile.peak_elo} label="Peak" countup />
                  <span className="rounded-full bg-[#17131C] px-2.5 py-0.5 text-[11px] font-semibold" style={{ color: league.color }}>
                    {league.name}
                  </span>
                </div>
                <div className="mt-5 flex h-28 items-end gap-4">
                  {(["VARC", "DILR", "QUANT"] as const).map((s, i) => (
                    <SectionBar key={s} label={SECTION_LOOK[s].label} pct={stat(s)?.questions_answered ? Number(stat(s)!.accuracy ?? 0) : null} delay={0.35 + i * 0.08} />
                  ))}
                </div>
                <p className="mt-2 text-[10px] uppercase tracking-wide opacity-60">Section accuracy</p>
              </PastelCard>

              <PastelCard color={C.rose} shape={<Crescent color={C.roseTone} className="-right-12 -top-10 h-48 w-48" />} className="sm:col-span-3">
                <CardTitle>Rating trend:</CardTitle>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
                  <Metric value={profile.elo} label="Now" />
                  <Metric value={`${trendDelta >= 0 ? "+" : ""}${trendDelta}`} label={`Last ${Math.max(eloCurve.length, 1)}`} />
                  <Metric value={winRate} label="Win rate" />
                </div>
                <div className="mt-2 h-32">
                  {eloCurve.length >= 2 ? <TrendChart data={eloCurve} /> : (
                    <p className="flex h-full items-center text-sm opacity-60">Play rated matches to draw your curve.</p>
                  )}
                </div>
              </PastelCard>

              <PastelCard color={C.sage} shape={<Burst color={C.sageTone} className="-bottom-12 -right-6 h-44 w-44" />} className="sm:col-span-3">
                <CardTitle>Today:</CardTitle>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <DailyGoal label="Play a match" value={dailyProgress.matches_today} target={1} />
                  <DailyGoal label="Win 2 matches" value={dailyProgress.wins_today} target={2} />
                </div>
              </PastelCard>

              <PastelCard color={C.peri} shape={<FlameShape color={C.periTone} className="-bottom-8 -right-6 h-40 w-36" />} className="sm:col-span-2">
                <CardTitle>Record:</CardTitle>
                <div className="mt-3 flex gap-5">
                  <Metric value={profile.wins} label="Wins" countup />
                  <Metric value={profile.losses} label="Losses" countup />
                  <Metric value={profile.draws} label="Draws" countup />
                </div>
                <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#17131C] px-3 py-1 text-xs font-semibold text-[#F5D96B]">
                  <Flame size={13} fill="currentColor" />
                  {profile.current_streak} streak · best {profile.best_streak}
                </div>
              </PastelCard>
            </div>

            <motion.div variants={rise}>
              <RecentMatches matches={recentMatches} />
            </motion.div>
          </motion.main>

          {/* ═════════ Right column: week + study timeline ═════════ */}
          <motion.aside
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 26, delay: 0.15 }}
            className="lg:sticky lg:top-6 lg:self-start"
          >
            <StudyTimeline
              initialPlan={plan}
              initialWeekStart={weekStart}
              initialRegens={regens}
              initialStart={profile.study_start_time}
              userId={profile.id}
              onFindMatch={handleFindMatch}
            />
          </motion.aside>
        </div>

        <ChallengeDialog open={showChallenge} onOpenChange={setShowChallenge} />
      </div>
    </MotionConfig>
  );
}

/* ─────────────────────────── Card primitives ─────────────────────────── */

// Rounded pastel block with spring hover/press and a gentle cursor tilt; its
// decorative shape parallaxes against the tilt so the card reads as layered.
function PastelCard({ color, shape, className, children }: { color: string; shape?: ReactNode; className?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const rx = useSpring(0, { stiffness: 200, damping: 20 });
  const ry = useSpring(0, { stiffness: 200, damping: 20 });
  // `|| 0` folds -0 to 0: SSR prints no transform, the client would print
  // translateX(-0px) and trip a hydration mismatch.
  const sx = useTransform(ry, (v) => v * -2.5 || 0);
  const sy = useTransform(rx, (v) => v * 2.5 || 0);

  return (
    <motion.div
      variants={rise}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.985 }}
      transition={SPRING}
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 6);
        rx.set(-((e.clientY - r.top) / r.height - 0.5) * 6);
      }}
      onPointerLeave={() => { rx.set(0); ry.set(0); }}
      style={{ backgroundColor: color, rotateX: rx, rotateY: ry, transformPerspective: 1000 }}
      className={cn("relative isolate overflow-hidden rounded-[28px] p-5 text-[#17131C] md:p-6", className)}
    >
      {shape && <motion.div aria-hidden style={{ x: sx, y: sy }} className="pointer-events-none absolute inset-0 -z-10">{shape}</motion.div>}
      {children}
    </motion.div>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-pixel text-lg">{children}</h3>;
}

function Metric({ value, label, big, countup }: { value: number | string; label: string; big?: boolean; countup?: boolean }) {
  return (
    <div>
      <div data-countup={countup ? "" : undefined} className={cn("font-bold tabular-nums leading-none", big ? "text-3xl" : "text-lg")}>
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide opacity-60">{label}</div>
    </div>
  );
}

function SectionBar({ label, pct, delay }: { label: string; pct: number | null; delay: number }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center gap-1.5">
      <div className="relative w-full flex-1">
        {pct === null ? (
          // No data yet: dashed ghost bar, like the ref's empty slots.
          <div className="absolute inset-x-2 bottom-0 h-1/3 rounded-full border-2 border-dashed border-[#17131C]/30" />
        ) : (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(pct, 6)}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 18, delay }}
            className="absolute inset-x-2 bottom-0 rounded-full bg-[#17131C]"
          />
        )}
      </div>
      <span className="text-[11px] font-semibold tabular-nums">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
      <span className="text-[10px] opacity-60">{label}</span>
    </div>
  );
}

function DailyGoal({ label, value, target }: { label: string; value: number; target: number }) {
  const v = Math.min(value, target);
  const done = v >= target;
  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{v}</span>
        <span className="text-sm opacity-60">/ {target}</span>
        {done && (
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 15, delay: 0.5 }} className="ml-1 rounded-full bg-[#17131C] px-2 py-0.5 text-[10px] font-semibold text-[#B7C97A]">
            done
          </motion.span>
        )}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#17131C]/15">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${(v / target) * 100}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20, delay: 0.4 }}
          className="h-full rounded-full bg-[#17131C]"
        />
      </div>
    </div>
  );
}

function ModePill({ icon, children, href, onClick, disabled }: { icon: ReactNode; children: ReactNode; href?: string; onClick?: () => void; disabled?: boolean }) {
  const cls = "flex items-center gap-1.5 rounded-full bg-[#17131C] px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-black disabled:opacity-60";
  const inner = <>{icon}{children}</>;
  return (
    <motion.span whileHover={{ y: -2 }} whileTap={{ scale: 0.95 }} transition={SPRING} className="inline-flex">
      {href ? <Link href={href} className={cls}>{inner}</Link> : <button onClick={onClick} disabled={disabled} className={cls}>{inner}</button>}
    </motion.span>
  );
}

function TrendChart({ data }: { data: number[] }) {
  const points = data.map((elo, i) => ({ i, elo }));
  const last = points[points.length - 1];
  const min = Math.min(...data), max = Math.max(...data);
  const pad = Math.max(10, (max - min) * 0.2);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
        <YAxis hide domain={[min - pad, max + pad]} />
        <ReferenceLine x={last.i} stroke={C.ink} strokeDasharray="3 3" strokeOpacity={0.5} />
        <Line
          type="monotone"
          dataKey="elo"
          stroke={C.ink}
          strokeWidth={2}
          isAnimationActive
          animationDuration={1400}
          animationEasing="ease-out"
          dot={(p: { cx?: number; cy?: number; index?: number }) =>
            p.index === last.i ? <circle key="last" cx={p.cx} cy={p.cy} r={4.5} fill={C.ink} /> : <g key={p.index} />
          }
          activeDot={{ r: 5, fill: C.ink, stroke: C.rose, strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ─────────────────────── Recent matches + detail ─────────────────────── */

interface Breakdown { section: string; answered: number; correct: number; points: number }

// true only on the client: dates below format in the viewer's timezone, which
// the server (UTC on Vercel) can't know.
const noop = () => () => {};
function useMounted() {
  return useSyncExternalStore(noop, () => true, () => false);
}

function RecentMatches({ matches }: { matches: RecentMatch[] }) {
  const mounted = useMounted();
  const [sel, setSel] = useState(matches[0]?.match_id ?? null);
  const [breakdowns, setBreakdowns] = useState<Record<string, Breakdown[] | "err">>({});
  const m = matches.find((x) => x.match_id === sel) ?? null;

  useEffect(() => {
    if (!sel || breakdowns[sel]) return;
    let cancelled = false;
    createClient().rpc("get_match_section_breakdown", { p_match_id: sel })
      .then(({ data, error }) => {
        if (!cancelled) setBreakdowns((b) => ({ ...b, [sel]: error || !data ? "err" : data }));
      });
    return () => { cancelled = true; };
  }, [sel, breakdowns]);

  if (!matches.length) {
    return (
      <div className="rounded-[28px] bg-[#17141d] p-6 text-sm text-white/55">
        <h3 className="mb-1 font-pixel text-lg text-white">Recent matches</h3>
        No matches yet — your first battle shows up here.
      </div>
    );
  }

  const bd = sel ? breakdowns[sel] : undefined;

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div>
        <h3 className="mb-3 font-pixel text-lg">Recent matches</h3>
        <ul className="space-y-2">
          {matches.map((x) => {
            const active = x.match_id === sel;
            return (
              <li key={x.match_id}>
                <motion.button
                  onClick={() => setSel(x.match_id)}
                  whileHover={{ x: active ? 0 : 3 }}
                  whileTap={{ scale: 0.98 }}
                  className={cn("relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", active ? "text-[#17131C]" : "bg-[#17141d] text-white hover:bg-[#1c1922]")}
                >
                  {active && (
                    // One rose highlight that slides between rows and visually
                    // flows into the rose detail panel beside it.
                    <motion.span layoutId="match-hl" transition={{ type: "spring", stiffness: 380, damping: 32 }} className="absolute inset-0 rounded-2xl bg-[#F7BFD8] md:-right-5 md:rounded-r-none" />
                  )}
                  <Avatar className="relative h-9 w-9 shrink-0">
                    <AvatarImage src={x.opponent_avatar ?? undefined} />
                    <AvatarFallback className="bg-[#17131C] text-[11px] font-bold text-[#06d6a0]">{x.opponent.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="relative min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">vs {x.opponent}</span>
                    <span className={cn("block text-[11px]", active ? "opacity-60" : "text-white/45")}>
                      {mounted && `${new Date(x.played_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · `}{x.my_score}–{x.opp_score}
                    </span>
                  </span>
                  <ResultChip result={x.result} delta={x.elo_delta} onLight={active} />
                </motion.button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="mb-3 font-pixel text-lg">Match details</h3>
        <div className="relative min-h-[240px] overflow-hidden rounded-[28px] bg-[#F7BFD8] p-5 text-[#17131C]">
          <AnimatePresence mode="popLayout" initial={false}>
            {m && (
              <motion.div
                key={m.match_id}
                initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -12, filter: "blur(4px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-semibold underline decoration-[#17131C]/30 underline-offset-4">vs {m.opponent}</p>
                    <p className="mt-0.5 h-4 text-xs opacity-60">{mounted && new Date(m.played_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                  </div>
                  <ResultChip result={m.result} delta={m.elo_delta} onLight />
                </div>

                <div className="mt-4 flex gap-6">
                  <Metric value={m.my_score} label="You" />
                  <Metric value={m.opp_score} label="Opponent" />
                  <Metric value={m.elo_delta === null ? "—" : `${m.elo_delta > 0 ? "+" : ""}${m.elo_delta}`} label="ELO" />
                </div>

                <div className="mt-4 space-y-2">
                  {bd === undefined ? (
                    [0, 1, 2].map((i) => <div key={i} className="h-6 animate-pulse rounded-full bg-[#17131C]/10" />)
                  ) : bd === "err" ? (
                    <p className="text-xs opacity-60">Section breakdown unavailable.</p>
                  ) : (
                    bd.map((r, i) => (
                      <div key={r.section} className="flex items-center gap-3 text-xs">
                        <span className="w-12 font-semibold">{SECTION_LOOK[r.section as "VARC"]?.label ?? r.section}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#17131C]/15">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${r.answered ? (r.correct / r.answered) * 100 : 0}%` }}
                            transition={{ type: "spring", stiffness: 140, damping: 20, delay: i * 0.06 }}
                            className="h-full rounded-full bg-[#17131C]"
                          />
                        </div>
                        <span className="w-16 text-right tabular-nums opacity-70">{r.correct}/{r.answered} · {r.points}</span>
                      </div>
                    ))
                  )}
                </div>

                <Link href={`/result/${m.match_id}`} className="mt-5 inline-flex items-center gap-1 rounded-full bg-[#17131C] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-black">
                  Full result & Ninja debrief <ArrowUpRight size={13} />
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ResultChip({ result, delta, onLight }: { result: string; delta: number | null; onLight?: boolean }) {
  const label = result === "win" ? "Win" : result === "loss" ? "Loss" : result === "draw" ? "Draw" : result;
  const color = result === "win" ? "#06d6a0" : result === "loss" ? "#ef476f" : "#F5D96B";
  return (
    <span
      className={cn("relative shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums", onLight ? "bg-[#17131C]" : "bg-white/[0.06]")}
      style={{ color }}
    >
      {label}
      {delta !== null && delta !== 0 && ` ${delta > 0 ? "+" : ""}${delta}`}
    </span>
  );
}

/* ─────────────────────────── Online pill ─────────────────────────── */

// The app's only online-count surface. One WS per authed lobby visitor,
// deduped across tabs by userId.
function OnlinePill({ userId }: { userId: string }) {
  const count = useOnlineCount(userId);
  if (count === null) return null;
  return (
    <div title={`${count} online now`} className="flex shrink-0 items-center gap-2 rounded-full bg-black px-3 py-1.5 ring-1 ring-white/10">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#06d6a0] opacity-50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#06d6a0]" />
      </span>
      <span className="text-xs font-semibold text-white">{count}</span>
      <span className="text-xs text-white/55">online</span>
    </div>
  );
}

/* ──────────────────── Decorative shapes (ninja / CAT) ──────────────────── */

type ShapeProps = { color: string; className?: string };

function Shuriken({ color, className, spin }: ShapeProps & { spin?: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 100 100"
      className={cn("absolute", className)}
      animate={spin ? { rotate: 360 } : undefined}
      transition={spin ? { duration: 40, repeat: Infinity, ease: "linear" } : undefined}
    >
      <path
        fill={color}
        fillRule="evenodd"
        d="M50 0 Q56 34 64 36 Q66 44 100 50 Q66 56 64 64 Q56 66 50 100 Q44 66 36 64 Q34 56 0 50 Q34 44 36 36 Q44 34 50 0Z M50 42a8 8 0 1 0 0.01 0Z"
      />
    </motion.svg>
  );
}

function Crown({ color, className }: ShapeProps) {
  return (
    <motion.svg viewBox="0 0 100 100" className={cn("absolute", className)} animate={{ rotate: [-8, -2, -8] }} transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}>
      <path fill={color} d="M8 82 L4 28 L30 50 L50 10 L70 50 L96 28 L92 82 Q50 92 8 82Z" />
    </motion.svg>
  );
}

// Katana arc — a crescent sweep.
function Crescent({ color, className }: ShapeProps) {
  return (
    <motion.svg viewBox="0 0 100 100" className={cn("absolute", className)} animate={{ rotate: [0, 10, 0] }} transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}>
      <path fill={color} d="M30 6 A46 46 0 1 0 94 70 A40 40 0 1 1 30 6Z" />
    </motion.svg>
  );
}

function Burst({ color, className }: ShapeProps) {
  const pts = Array.from({ length: 20 }, (_, i) => {
    const r = i % 2 ? 30 : 50, a = (i / 20) * Math.PI * 2;
    // toFixed: Node and the browser disagree in the last float digits of
    // cos/sin, which would mismatch on hydration.
    return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return (
    <motion.svg viewBox="0 0 100 100" className={cn("absolute", className)} animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: "linear" }}>
      <polygon fill={color} points={pts} strokeLinejoin="round" stroke={color} strokeWidth={4} />
    </motion.svg>
  );
}

function FlameShape({ color, className }: ShapeProps) {
  return (
    <motion.svg
      viewBox="0 0 100 120"
      className={cn("absolute origin-bottom", className)}
      animate={{ scaleY: [1, 1.06, 0.98, 1], skewX: [0, 2, -2, 0] }}
      transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
    >
      <path fill={color} d="M50 0 C58 28 88 42 88 76 A38 38 0 0 1 12 76 C12 56 26 46 30 28 C40 40 42 48 48 54 C56 36 54 18 50 0Z" />
    </motion.svg>
  );
}
