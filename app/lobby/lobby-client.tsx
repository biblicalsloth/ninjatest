"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  AnimatePresence, MotionConfig, motion, useReducedMotion, useSpring, useTransform, type Variants,
} from "motion/react";
import { LineChart, Line, ResponsiveContainer, ReferenceLine, YAxis } from "recharts";
import { Zap, Users, Eye, Trophy, Flame, ArrowUpRight, Play } from "lucide-react";
import { useOnlineCount } from "@/lib/hooks/use-online-count";
import { createClient } from "@/lib/supabase/client";
import { ChallengeDialog } from "@/components/challenge-dialog";
import { PlayDialog, type PlayMode } from "@/components/play-dialog";
import { C, Shuriken, Crown, Crescent, Burst, FlameShape } from "@/components/lobby-shapes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Profile } from "@/lib/supabase/types";
import type { StudyPlan } from "@/lib/ai/model";
import { PLAN_DAYS } from "@/lib/ai/model";
import { cn, getWinRate } from "@/lib/utils";
import { getLeague } from "@/lib/leagues";
import { gsap, useGSAP, countTo, prefersReduced } from "@/lib/motion";
import { StudyTimeline, todayIndex, SECTION_LOOK } from "./study-timeline";

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
const container: Variants = { show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } };
const rise: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 220, damping: 24 } },
};

export default function LobbyClient({
  profile, dailyProgress, sectionStats, recentMatches, eloCurve, plan, weekStart, regens,
}: Props) {
  const router = useRouter();
  const [starting, setStarting] = useState<PlayMode | null>(null);
  const [showPlay, setShowPlay] = useState(false);
  const [showChallenge, setShowChallenge] = useState(false);
  const displayName = profile.display_name ?? profile.username;

  async function handleFindMatch() {
    if (starting) return;
    setStarting("ranked");
    const supabase = createClient();
    const { error } = await supabase.rpc("join_queue");
    if (error) {
      toast.error("Failed to join queue: " + error.message);
      setStarting(null);
      return;
    }
    router.push("/queue");
  }

  function handlePick(mode: PlayMode) {
    if (mode === "ranked") return handleFindMatch();
    setStarting(mode);
    // /arena joins its own queue on mount (it owns the whole queue → ready →
    // play loop), so the lobby only routes.
    router.push(mode === "arena" ? "/arena" : "/practice");
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
  const goalsDone = (dailyProgress.matches_today >= 1 ? 1 : 0) + (dailyProgress.wins_today >= 2 ? 1 : 0);
  const decided = profile.wins + profile.losses + profile.draws;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={scope} className="min-h-screen bg-[#120F17] text-white">
        <div className="mx-auto grid max-w-[1360px] grid-cols-1 gap-6 px-4 py-5 md:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* ═════════ Main column ═════════ */}
          <motion.main variants={container} initial="hidden" animate="show" className="min-w-0 space-y-3">
            <motion.header variants={rise} className="flex items-center justify-between gap-4 pb-1 pt-1">
              <div className="min-w-0">
                <h1 className="font-pixel text-2xl leading-tight break-words md:text-[28px]">
                  {greeting}, <span className="text-[#06d6a0]">{displayName}</span>
                </h1>
                <p className="mt-1 max-w-xl text-[13px] text-white/50">
                  {tasksToday
                    ? `Ninja has ${tasksToday} task${tasksToday > 1 ? "s" : ""} on today's plan.`
                    : "Sharpen up — every battle moves your rating."}
                  {profile.current_streak >= 2 && ` You're on a ${profile.current_streak}-win streak.`}
                </p>
              </div>
              <OnlinePill userId={profile.id} />
            </motion.header>

            {/* ── Play (mint, full width, one row) ── */}
            <PastelCard
              color={C.mint}
              shape={<Shuriken color={C.mintTone} className="-right-6 -top-12 h-40 w-40" spin />}
              className="min-h-0 px-4 py-3.5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <motion.button
                  whileHover={{ x: 3 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setShowPlay(true)}
                  disabled={!!starting}
                  className="flex items-center gap-3 text-left disabled:opacity-70"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#17131C] text-[#06d6a0]">
                    {starting ? <Zap size={18} fill="currentColor" className="animate-pulse" /> : <Play size={18} fill="currentColor" className="translate-x-px" />}
                  </span>
                  <span>
                    <span className="block font-pixel text-2xl leading-none">{starting === "ranked" ? "Joining queue…" : "Play"}</span>
                    <span className="mt-1 block text-xs opacity-70">Ranked 1v1 · Arena · Practice drill</span>
                  </span>
                </motion.button>
                <div className="flex flex-wrap gap-1.5">
                  <ModePill icon={<Users size={13} />} onClick={() => setShowChallenge(true)}>Challenge</ModePill>
                  <ModePill icon={<Eye size={13} />} href="/spectate">Spectate</ModePill>
                  <ModePill icon={<Trophy size={13} />} href="/leaderboard">Leaderboard</ModePill>
                </div>
              </div>
            </PastelCard>

            {/* ── 4 equal stat cards: title row · metrics · visual pinned bottom ── */}
            <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PastelCard color={C.butter} shape={<Crown color={C.butterTone} className="-right-6 -top-5 h-24 w-24" />}>
                <CardTitle aside={<span className="rounded-full bg-[#17131C] px-2 py-0.5 text-[10px] font-semibold" style={{ color: league.color }}>{league.name}</span>}>
                  Rating
                </CardTitle>
                <div className="mt-2.5 flex items-baseline gap-4">
                  <Metric value={profile.elo} label="Current" big countup />
                  <Metric value={profile.peak_elo} label="Peak" countup />
                </div>
                <div className="mt-auto flex h-16 items-end gap-2 pt-3">
                  {(["VARC", "DILR", "QUANT"] as const).map((s, i) => (
                    <SectionBar key={s} label={SECTION_LOOK[s].label} pct={stat(s)?.questions_answered ? Number(stat(s)!.accuracy ?? 0) : null} delay={0.35 + i * 0.08} />
                  ))}
                </div>
              </PastelCard>

              <PastelCard color={C.rose} shape={<Crescent color={C.roseTone} className="-right-8 -top-8 h-28 w-28" />}>
                <CardTitle aside={<Chip>{`${trendDelta >= 0 ? "+" : ""}${trendDelta}`}</Chip>}>Trend</CardTitle>
                <div className="mt-2.5 flex gap-4">
                  <Metric value={profile.elo} label="Now" big />
                  <Metric value={winRate} label="Win rate" />
                </div>
                <div className="mt-auto h-16 pt-2">
                  {eloCurve.length >= 2 ? <TrendChart data={eloCurve} /> : (
                    <p className="flex h-full items-end text-xs opacity-60">Play rated matches to draw your curve.</p>
                  )}
                </div>
              </PastelCard>

              <PastelCard color={C.sage} shape={<Burst color={C.sageTone} className="-bottom-8 -right-5 h-28 w-28" />}>
                <CardTitle aside={<Chip>{goalsDone}/2 done</Chip>}>Today</CardTitle>
                <div className="mt-auto space-y-3 pt-3">
                  <DailyGoal label="Play a match" value={dailyProgress.matches_today} target={1} />
                  <DailyGoal label="Win 2 matches" value={dailyProgress.wins_today} target={2} />
                </div>
              </PastelCard>

              <PastelCard color={C.peri} shape={<FlameShape color={C.periTone} className="-bottom-6 -right-4 h-28 w-24" />}>
                <CardTitle aside={<Chip><Flame size={11} fill="currentColor" className="-mt-px mr-0.5 inline text-[#F5D96B]" />{profile.current_streak}</Chip>}>
                  Record
                </CardTitle>
                <div className="mt-2.5 flex gap-4">
                  <Metric value={profile.wins} label="Wins" big countup />
                  <Metric value={profile.losses} label="Losses" countup />
                  <Metric value={profile.draws} label="Draws" countup />
                </div>
                <div className="mt-auto pt-3">
                  {/* W/L/D split as one segmented bar */}
                  <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-[#17131C]/15">
                    {decided > 0 && [profile.wins, profile.losses, profile.draws].map((v, i) => (
                      <motion.div
                        key={i}
                        initial={{ width: 0 }}
                        animate={{ width: `${(v / decided) * 100}%` }}
                        transition={{ type: "spring", stiffness: 120, damping: 20, delay: 0.4 + i * 0.06 }}
                        className="h-full rounded-full bg-[#17131C]"
                        style={{ opacity: 1 - i * 0.3 }}
                      />
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] uppercase tracking-wide opacity-60">Best streak {profile.best_streak}</p>
                </div>
              </PastelCard>
            </div>

            <motion.div variants={rise} className="pt-2">
              <RecentMatches matches={recentMatches} />
            </motion.div>
          </motion.main>

          {/* ═════════ Right rail: week + study timeline ═════════ */}
          <motion.aside
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 26, delay: 0.15 }}
            className="lg:sticky lg:top-5 lg:max-h-[calc(100vh-2.5rem)] lg:self-start lg:overflow-y-auto lg:rounded-[24px] lg:[scrollbar-width:thin]"
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

        <PlayDialog open={showPlay} onOpenChange={setShowPlay} onPick={handlePick} busy={starting} />
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
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      transition={SPRING}
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 5);
        rx.set(-((e.clientY - r.top) / r.height - 0.5) * 5);
      }}
      onPointerLeave={() => { rx.set(0); ry.set(0); }}
      style={{ backgroundColor: color, rotateX: rx, rotateY: ry, transformPerspective: 1000 }}
      className={cn("relative isolate flex min-h-[164px] flex-col overflow-hidden rounded-[20px] p-4 text-[#17131C]", className)}
    >
      {shape && <motion.div aria-hidden style={{ x: sx, y: sy }} className="pointer-events-none absolute inset-0 -z-10">{shape}</motion.div>}
      {children}
    </motion.div>
  );
}

function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] opacity-70">{children}</h3>
      {aside}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-[#17131C] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-white">{children}</span>;
}

function Metric({ value, label, big, countup }: { value: number | string; label: string; big?: boolean; countup?: boolean }) {
  return (
    <div>
      <div data-countup={countup ? "" : undefined} className={cn("font-bold tabular-nums leading-none", big ? "text-2xl" : "text-base")}>
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide opacity-60">{label}</div>
    </div>
  );
}

function SectionBar({ label, pct, delay }: { label: string; pct: number | null; delay: number }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center gap-1">
      <div className="relative w-full flex-1">
        {pct === null ? (
          // No data yet: dashed ghost bar.
          <div className="absolute inset-x-1.5 bottom-0 h-1/3 rounded-full border-2 border-dashed border-[#17131C]/30" />
        ) : (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(pct, 8)}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 18, delay }}
            className="absolute inset-x-1.5 bottom-0 rounded-full bg-[#17131C]"
          />
        )}
      </div>
      <span className="text-[10px] leading-none tabular-nums">
        <span className="font-semibold">{pct === null ? "—" : `${Math.round(pct)}%`}</span> <span className="opacity-60">{label}</span>
      </span>
    </div>
  );
}

function DailyGoal({ label, value, target }: { label: string; value: number; target: number }) {
  const v = Math.min(value, target);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold">{label}</span>
        <span className="tabular-nums opacity-70">{v}/{target}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#17131C]/15">
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

function ModePill({ icon, children, href, onClick }: { icon: ReactNode; children: ReactNode; href?: string; onClick?: () => void }) {
  const cls = "flex items-center gap-1.5 rounded-full bg-[#17131C] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black";
  const inner = <>{icon}{children}</>;
  return (
    <motion.span whileHover={{ y: -2 }} whileTap={{ scale: 0.95 }} transition={SPRING} className="inline-flex">
      {href ? <Link href={href} className={cls}>{inner}</Link> : <button onClick={onClick} className={cls}>{inner}</button>}
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
      <LineChart data={points} margin={{ top: 6, right: 6, bottom: 2, left: 2 }}>
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
            p.index === last.i ? <circle key="last" cx={p.cx} cy={p.cy} r={4} fill={C.ink} /> : <g key={p.index} />
          }
          activeDot={{ r: 4.5, fill: C.ink, stroke: C.rose, strokeWidth: 2 }}
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

// Tab → panel "melt": the active row's rose highlight runs flush into the rose
// detail panel, and two concave fillets (FILLET px) round the joint above and
// below so it reads as one shape. Inactive rows stop FILLET px short of the
// panel (md:mr-3), which is the gutter the fillets live in — so they never
// paint over a neighbouring row. Everything rides the same layoutId spring.
const MORPH = { type: "spring", stiffness: 420, damping: 34 } as const;
const ROSE = C.rose;

function RecentMatches({ matches }: { matches: RecentMatch[] }) {
  const mounted = useMounted();
  const [sel, setSel] = useState(matches[0]?.match_id ?? null);
  const [breakdowns, setBreakdowns] = useState<Record<string, Breakdown[] | "err">>({});
  const m = matches.find((x) => x.match_id === sel) ?? null;
  const selIdx = matches.findIndex((x) => x.match_id === sel);
  // When the panel outgrows the list, the last row no longer sits on the
  // panel's bottom edge — it needs its lower fillet and the panel keeps its
  // corner. Tracked live because the panel's height changes with its content.
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [listShorter, setListShorter] = useState(false);
  useLayoutEffect(() => {
    const l = listRef.current, p = panelRef.current;
    if (!l || !p) return;
    const check = () => setListShorter(l.offsetHeight < p.offsetHeight - 2);
    const ro = new ResizeObserver(check);
    ro.observe(l); ro.observe(p);
    return () => ro.disconnect();
  }, [matches.length]);

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
      <div className="rounded-[20px] bg-[#17141d] p-4 text-[13px] text-white/55">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">Recent matches</h3>
        No matches yet — your first battle shows up here.
      </div>
    );
  }

  const bd = sel ? breakdowns[sel] : undefined;
  const firstActive = selIdx === 0;
  const lastActive = selIdx === matches.length - 1 && !listShorter;

  return (
    <div>
      <div className="mb-2 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">Recent matches</h3>
        <h3 className="hidden pl-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70 md:block">Match details</h3>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-0">
        <ul ref={listRef} className="space-y-1.5 self-start">
          {matches.map((x, i) => {
            const active = x.match_id === sel;
            return (
              <li key={x.match_id} className="md:mr-3">
                <motion.button
                  onClick={() => setSel(x.match_id)}
                  whileHover={{ x: active ? 0 : 2 }}
                  whileTap={{ scale: 0.985 }}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-left transition-colors",
                    active ? "text-[#17131C]" : "bg-[#17141d] text-white hover:bg-[#1c1922]"
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="match-hl"
                      transition={MORPH}
                      className="absolute inset-y-0 left-0 right-0 rounded-2xl md:-right-3 md:rounded-r-none"
                      style={{ backgroundColor: ROSE }}
                    >
                      {/* concave fillets into the panel (hidden at the panel's own top/bottom edge) */}
                      {i > 0 && (
                        <span
                          aria-hidden
                          className="absolute -top-3 right-0 hidden h-3 w-3 md:block"
                          style={{ background: `radial-gradient(circle at 0 0, transparent 11.5px, ${ROSE} 12px)` }}
                        />
                      )}
                      {(i < matches.length - 1 || listShorter) && (
                        <span
                          aria-hidden
                          className="absolute -bottom-3 right-0 hidden h-3 w-3 md:block"
                          style={{ background: `radial-gradient(circle at 0 100%, transparent 11.5px, ${ROSE} 12px)` }}
                        />
                      )}
                    </motion.span>
                  )}
                  <Avatar className="relative h-8 w-8 shrink-0">
                    <AvatarImage src={x.opponent_avatar ?? undefined} />
                    <AvatarFallback className="bg-[#17131C] text-[10px] font-bold text-[#06d6a0]">{x.opponent.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="relative min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">vs {x.opponent}</span>
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

        {/* Panel corners square off where the active tab meets its top/bottom
            edge, so the joint stays one continuous shape. */}
        <motion.div
          ref={panelRef}
          layout
          animate={{
            borderTopLeftRadius: firstActive ? 0 : 20,
            borderBottomLeftRadius: lastActive ? 0 : 20,
          }}
          transition={MORPH}
          className="relative min-h-[220px] overflow-hidden rounded-[20px] p-4 text-[#17131C] max-md:!rounded-[20px]"
          style={{ backgroundColor: ROSE }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {m && (
              <motion.div
                key={m.match_id}
                initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">vs {m.opponent}</p>
                    <p className="mt-0.5 h-4 text-[11px] opacity-60">{mounted && new Date(m.played_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                  </div>
                  <ResultChip result={m.result} delta={m.elo_delta} onLight />
                </div>

                <div className="mt-3 flex gap-5">
                  <Metric value={m.my_score} label="You" big />
                  <Metric value={m.opp_score} label="Opponent" big />
                  <Metric value={m.elo_delta === null ? "—" : `${m.elo_delta > 0 ? "+" : ""}${m.elo_delta}`} label="ELO" big />
                </div>

                <div className="mt-3 space-y-1.5">
                  {bd === undefined ? (
                    [0, 1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded-full bg-[#17131C]/10" />)
                  ) : bd === "err" ? (
                    <p className="text-xs opacity-60">Section breakdown unavailable.</p>
                  ) : (
                    bd.map((r, i) => (
                      <div key={r.section} className="flex items-center gap-3 text-[11px]">
                        <span className="w-11 font-semibold">{SECTION_LOOK[r.section as "VARC"]?.label ?? r.section}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#17131C]/15">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${r.answered ? (r.correct / r.answered) * 100 : 0}%` }}
                            transition={{ type: "spring", stiffness: 140, damping: 20, delay: i * 0.06 }}
                            className="h-full rounded-full bg-[#17131C]"
                          />
                        </div>
                        <span className="w-14 text-right tabular-nums opacity-70">{r.correct}/{r.answered} · {r.points}</span>
                      </div>
                    ))
                  )}
                </div>

                <Link href={`/result/${m.match_id}`} className="mt-4 inline-flex items-center gap-1 rounded-full bg-[#17131C] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-black">
                  Full result & Ninja debrief <ArrowUpRight size={12} />
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

function ResultChip({ result, delta, onLight }: { result: string; delta: number | null; onLight?: boolean }) {
  const label = result === "win" ? "Win" : result === "loss" ? "Loss" : result === "draw" ? "Draw" : result;
  const color = result === "win" ? "#06d6a0" : result === "loss" ? "#ef476f" : "#F5D96B";
  return (
    <span
      className={cn("relative shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums", onLight ? "bg-[#17131C]" : "bg-white/[0.06]")}
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
