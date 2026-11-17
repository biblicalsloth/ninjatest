"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen, Puzzle, Sigma, Swords, Coffee, Check, Clock, RefreshCw, ChevronDown, Play, Sparkles, Loader2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PLAN_DAYS, type PlanDay, type PlanSection, type PlanTask, type StudyPlan } from "@/lib/ai/model";
import { NinjaDailyFocus } from "@/components/ninja-daily-focus";
import { cn } from "@/lib/utils";

// Lobby right column: week strip (with activity dots) + today's study-plan
// timeline. The plan is Ninja's cached weekly JSON (/api/ninja/plan); this
// component only lays it out in clock time from profiles.study_start_time and
// marks tasks done from get_week_activity ("touched that section that day").

export const SECTION_LOOK: Record<PlanSection, { color: string; Icon: typeof BookOpen; label: string }> = {
  VARC:  { color: "#A9BDF2", Icon: BookOpen, label: "VARC" },
  DILR:  { color: "#F5D96B", Icon: Puzzle,   label: "DILR" },
  QUANT: { color: "#06d6a0", Icon: Sigma,    label: "Quant" },
  MIXED: { color: "#F7BFD8", Icon: Swords,   label: "Ranked mix" },
  REST:  { color: "#B7C97A", Icon: Coffee,   label: "Rest" },
};

const DAY_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
// Plan dates are built from a DATE string (no timezone), so only the locale
// can differ server vs client — pin it so SSR and hydration print the same.
const LOCALE = "en-US";
const DEFAULT_START = "19:00";
const PX_PER_MIN = 1.5; // 30 min ≈ 45px: tall enough that half-hour ticks never collide

// week_start is a plain DATE ("2026-11-16", a Monday). Built field-by-field:
// new Date("2026-11-16") is UTC midnight and shifts a day west of UTC.
function dayDate(weekStart: string, i: number): Date {
  const [y, m, d] = weekStart.split("-").map(Number);
  return new Date(y, m - 1, d + i);
}
function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
/** Index of today inside the plan week, or -1. */
export function todayIndex(weekStart: string | null, now = new Date()): number {
  if (!weekStart) return -1;
  for (let i = 0; i < 7; i++) if (isoDate(dayDate(weekStart, i)) === isoDate(now)) return i;
  return -1;
}
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmt(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function currentWeekStart(): string {
  const now = new Date();
  return isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)));
}

function isDone(t: PlanTask, sections: string[] | undefined): boolean {
  if (!sections?.length || t.section === "REST") return false;
  return t.section === "MIXED" ? true : sections.includes(t.section);
}

type Filter = "ALL" | "VARC" | "DILR" | "QUANT";

export function StudyTimeline({
  initialPlan, initialWeekStart, initialRegens, initialStart, userId, onFindMatch,
}: {
  initialPlan: StudyPlan | null;
  initialWeekStart: string | null;
  initialRegens: number;
  initialStart: string | null;
  userId: string;
  onFindMatch: () => void;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState(initialPlan);
  const [week, setWeek] = useState(initialWeekStart ?? currentWeekStart());
  const [regens, setRegens] = useState(initialRegens);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(initialStart?.slice(0, 5) ?? null);
  const [editingStart, setEditingStart] = useState(false);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [activity, setActivity] = useState<Record<string, string[]>>({});
  // null until mount: server and client clocks differ, so anything "now"-
  // dependent renders client-side only (no hydration mismatch).
  const [now, setNow] = useState<Date | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const today = now ? todayIndex(week, now) : -1;
  const day = selected ?? (today >= 0 ? today : 0);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .rpc("get_week_activity", {
        p_week_start: week,
        p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setActivity(Object.fromEntries(data.map((r) => [r.day, r.sections])));
      });
    return () => { cancelled = true; };
  }, [week]);

  async function generate(regenerate: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ninja/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Ninja could not build your plan");
        return;
      }
      setPlan(json.plan ?? null);
      if (json.week_start) setWeek(json.week_start);
      setRegens(json.regens ?? regens);
      if (regenerate) toast.success("Fresh week, built from your latest numbers");
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function saveStart(v: string) {
    setEditingStart(false);
    if (!v || v === start) return;
    const prev = start;
    setStart(v);
    const supabase = createClient();
    const { error } = await supabase.from("profiles").update({ study_start_time: v }).eq("id", userId);
    if (error) {
      setStart(prev);
      toast.error("Couldn't save your start time");
    }
  }

  // Slots stack back-to-back from the start time over the WHOLE day, then the
  // filter hides rows — so filtering never shifts a task's clock time.
  const dayKey: PlanDay = PLAN_DAYS[day];
  const slots = useMemo(() => {
    const base = toMin(start ?? DEFAULT_START);
    const tasks = plan?.days[dayKey] ?? [];
    return tasks.map((task, i) => {
      const s = base + tasks.slice(0, i).reduce((n, x) => n + x.minutes, 0);
      return { key: `${dayKey}-${i}`, task, start: s, end: s + task.minutes };
    });
  }, [plan, dayKey, start]);
  const visible = slots.filter((s) => filter === "ALL" || s.task.section === filter);

  const sectionsToday = activity[isoDate(dayDate(week, day))];
  const nowMin = now ? now.getHours() * 60 + now.getMinutes() : -1;
  const isToday = day === today;
  const dayEnd = slots.length ? slots[slots.length - 1].end : 0;

  return (
    <div className="space-y-5">
      {/* ── Week strip ───────────────────────────────────────────── */}
      <div className="rounded-[28px] bg-[#17141d] p-4">
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="font-pixel text-sm text-white">This week</span>
          <span className="rounded-full bg-[#F7BFD8] px-3 py-0.5 text-[11px] font-semibold text-[#17131C]">
            {dayDate(week, 0).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })} –{" "}
            {dayDate(week, 6).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}
          </span>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {DAY_SHORT.map((d, i) => {
            const date = dayDate(week, i);
            const secs = activity[isoDate(date)] ?? [];
            const active = i === day;
            return (
              <button
                key={d}
                onClick={() => setSelected(i)}
                className="relative flex flex-col items-center gap-1 rounded-2xl py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[#06d6a0]"
              >
                {active && (
                  <motion.span
                    layoutId="week-day"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-2xl bg-white/[0.07]"
                  />
                )}
                <span className="relative text-white/45">{d}</span>
                <span
                  className={cn(
                    "relative flex h-8 w-8 items-center justify-center rounded-full font-semibold tabular-nums transition-colors",
                    i === today ? "bg-[#06d6a0] text-[#17131C]" : active ? "text-white" : "text-white/80"
                  )}
                >
                  {date.getDate()}
                </span>
                {/* Activity heat: one dot per section touched that day. */}
                <span className="relative flex h-1.5 gap-0.5">
                  {secs.slice(0, 3).map((s) => (
                    <motion.span
                      key={s}
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 500, damping: 20 }}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: SECTION_LOOK[s as PlanSection]?.color ?? "#fff" }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-[28px] bg-[#17141d] px-4 pt-1 pb-3 [&>div]:!mt-0 [&>div]:!border-0 empty:hidden">
        <NinjaDailyFocus />
      </div>

      {/* ── Timeline header ─────────────────────────────────────── */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="font-pixel text-xl text-white">
            {dayDate(week, day).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}
          </h2>
          <div className="relative">
            <button
              onClick={() => setEditingStart((v) => !v)}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white"
            >
              <Clock size={12} />
              {start ? `from ${start}` : "Set start time"}
            </button>
            <AnimatePresence>
              {editingStart && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 500, damping: 32 }}
                  className="absolute right-0 top-8 z-20 rounded-2xl bg-black p-3 shadow-xl ring-1 ring-white/10"
                >
                  <label className="mb-1.5 block text-[11px] text-white/50">I start studying at</label>
                  <input
                    type="time"
                    autoFocus
                    defaultValue={start ?? DEFAULT_START}
                    onKeyDown={(e) => e.key === "Enter" && saveStart(e.currentTarget.value)}
                    onBlur={(e) => saveStart(e.currentTarget.value)}
                    className="rounded-lg bg-white/10 px-2 py-1 text-sm text-white [color-scheme:dark] outline-none focus:ring-2 focus:ring-[#06d6a0]"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-sm text-white/50">{isToday ? "Today's timeline" : `${dayDate(week, day).toLocaleDateString(LOCALE, { weekday: "long" })}'s timeline`}</span>
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                aria-label="Filter by section"
                className="appearance-none rounded-full bg-black py-1.5 pl-3 pr-7 text-xs font-medium text-white outline-none ring-1 ring-white/10 focus:ring-[#06d6a0]"
              >
                <option value="ALL">All</option>
                <option value="VARC">VARC</option>
                <option value="DILR">DILR</option>
                <option value="QUANT">Quant</option>
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/60" />
            </div>
            {plan && (
              <button
                onClick={() => generate(true)}
                disabled={busy || regens >= 1}
                aria-label="Regenerate plan"
                title={regens >= 1 ? "One regenerate per week — used" : "Regenerate this week's plan"}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-black text-white ring-1 ring-white/10 transition hover:ring-[#06d6a0]/60 disabled:opacity-40"
              >
                <RefreshCw size={13} className={cn(busy && "animate-spin")} />
              </button>
            )}
          </div>
        </div>

        {/* ── Timeline body ─────────────────────────────────────── */}
        {!plan ? (
          <EmptyPlan busy={busy} onGenerate={() => generate(false)} />
        ) : visible.length === 0 ? (
          <p className="rounded-2xl bg-[#17141d] px-4 py-6 text-center text-sm text-white/50">
            {slots.length ? "Nothing in this section today." : "Nothing planned — enjoy the rest day."}
          </p>
        ) : (
          <motion.ol layout className="relative">
            {isToday && nowMin >= 0 && nowMin < (slots[0]?.start ?? 0) && (
              <li className="mb-2 pl-14 text-[11px] text-white/45">Starts in {fmtDur((slots[0]?.start ?? 0) - nowMin)}</li>
            )}
            <AnimatePresence initial={false}>
              {visible.map((s, i) => {
                const done = isDone(s.task, sectionsToday);
                const current = isToday && nowMin >= s.start && nowMin < s.end;
                const past = isToday && nowMin >= s.end;
                return (
                  <TimelineRow
                    key={s.key}
                    index={i}
                    slot={s}
                    done={done}
                    current={current}
                    past={past}
                    nowMin={current ? nowMin : null}
                    onStart={() => (s.task.section === "MIXED" ? onFindMatch() : router.push("/practice"))}
                  />
                );
              })}
            </AnimatePresence>
            {isToday && nowMin >= dayEnd && slots.length > 0 && (
              <li className="mt-1 pl-14 text-[11px] text-white/45">Day&apos;s plan wrapped at {fmt(dayEnd)}.</li>
            )}
          </motion.ol>
        )}

        <Link
          href="/plan"
          className="mt-4 flex w-full items-center justify-center rounded-full bg-black py-3 text-sm font-medium text-white ring-1 ring-white/10 transition hover:ring-white/25 active:scale-[0.99]"
        >
          Open full plan
        </Link>
      </div>
    </div>
  );
}

function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

function TimelineRow({
  slot, index, done, current, past, nowMin, onStart,
}: {
  slot: { task: PlanTask; start: number; end: number };
  index: number;
  done: boolean;
  current: boolean;
  past: boolean;
  nowMin: number | null;
  onStart: () => void;
}) {
  const { task, start, end } = slot;
  const look = SECTION_LOOK[task.section];
  const span = Math.max(end - start, 30);
  // Half-hour ticks that fall inside this slot, as a fraction of the row, so
  // the axis needs no DOM measuring: the row's own height is the scale. Ticks
  // within 12 min of either end are dropped so labels never stack.
  const ticks: number[] = [start];
  for (let t = Math.ceil((start + 1) / 30) * 30; t < start + span; t += 30) {
    if (t - start >= 12 && start + span - t >= 12) ticks.push(t);
  }
  const nowFrac = nowMin !== null ? (nowMin - start) / span : null;
  // The now-pill sits on the same axis; drop any tick it would cover.
  if (nowMin !== null) for (let i = ticks.length - 1; i >= 0; i--) if (Math.abs(ticks[i] - nowMin) < 10) ticks.splice(i, 1);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0, transition: { type: "spring", stiffness: 260, damping: 26, delay: index * 0.05 } }}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.15 } }}
      className="relative flex"
      style={{ minHeight: span * PX_PER_MIN }}
    >
      <div className="relative w-12 shrink-0">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute left-0 -translate-y-1/2 text-[11px] tabular-nums text-white/40"
            style={{ top: `${((t - start) / span) * 100}%`, marginTop: t === start ? 8 : 0 }}
          >
            {fmt(t)}
          </span>
        ))}
      </div>

      <div className="relative flex-1 border-l border-dashed border-white/10 pb-2 pl-3">
        <motion.div
          layout
          animate={{ opacity: done || past ? 0.55 : 1, scale: done ? 0.985 : 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          whileHover={{ y: -2 }}
          className={cn(
            "relative h-full overflow-hidden rounded-2xl p-3",
            current ? "bg-[#211d29] ring-1 ring-[#06d6a0]/40" : "bg-[#17141d]"
          )}
        >
          <div className="flex items-start gap-3">
            <span className="relative mt-0.5 shrink-0">
              {current && (
                <motion.span
                  className="absolute inset-0 rounded-full"
                  style={{ backgroundColor: look.color }}
                  animate={{ scale: [1, 1.6], opacity: [0.5, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <span
                className="relative flex h-9 w-9 items-center justify-center rounded-full"
                style={current ? { backgroundColor: look.color, color: "#17131C" } : { backgroundColor: `${look.color}26`, color: look.color }}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {done ? (
                    <motion.span key="done" initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}>
                      <Check size={16} strokeWidth={3} />
                    </motion.span>
                  ) : (
                    <motion.span key="icon" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                      <look.Icon size={16} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium text-white", !current && "line-clamp-2", done && "line-through decoration-white/30")}>
                {task.task}
              </p>
              <p className="mt-0.5 text-[11px] text-white/45">
                {look.label}
                {task.minutes > 0 && ` · ${task.minutes} min`} · {fmt(start)} – {fmt(end)}
              </p>
              <AnimatePresence initial={false}>
                {current && task.section !== "REST" && !done && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center gap-2 pt-3">
                      <motion.button
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                        onClick={onStart}
                        className="flex items-center gap-1.5 rounded-full bg-[#06d6a0] px-3.5 py-1.5 text-xs font-semibold text-[#17131C]"
                      >
                        <Play size={12} fill="currentColor" />
                        {task.section === "MIXED" ? "Find ranked match" : "Start drill"}
                      </motion.button>
                      {nowMin !== null && <span className="text-[11px] text-white/45">{end - nowMin} min left</span>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Now line: glides inside the current row (CSS transition on `top`). */}
      {nowFrac !== null && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex items-center transition-[top] duration-1000 ease-linear"
          style={{ top: `${Math.min(Math.max(nowFrac, 0), 1) * 100}%` }}
        >
          <span className="-translate-y-1/2 rounded-full bg-[#06d6a0] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#17131C]">
            {fmt(nowMin!)}
          </span>
          <span className="h-px flex-1 -translate-y-1/2 border-t border-dashed border-[#06d6a0]/70" />
        </div>
      )}
    </motion.li>
  );
}

function EmptyPlan({ busy, onGenerate }: { busy: boolean; onGenerate: () => void }) {
  return (
    <div className="relative">
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <span className="w-9 pt-3 text-[11px] text-white/20">--:--</span>
            <div className="h-16 flex-1 animate-pulse rounded-2xl bg-[#17141d]" style={{ animationDelay: `${i * 150}ms` }} />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onGenerate}
          disabled={busy}
          className="flex items-center gap-2 rounded-full bg-[#06d6a0] px-5 py-2.5 text-sm font-semibold text-[#17131C] shadow-[0_10px_30px_-10px_#06d6a0] disabled:opacity-80"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {busy ? "Ninja is planning…" : "Build my week with Ninja"}
        </motion.button>
        <span className="text-[11px] text-white/45">From your real section stats</span>
      </div>
    </div>
  );
}
