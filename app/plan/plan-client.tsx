"use client";

import { useState } from "react";
import { CalendarDays, Loader2, RefreshCw, X } from "lucide-react";
import { NinjaNav } from "@/components/ninja-nav";
import { getSectionBadgeClass } from "@/lib/utils";
import { PLAN_DAYS, type PlanDay, type PlanSection, type StudyPlan } from "@/lib/ai/model";
import type { CatSection } from "@/lib/supabase/types";

// /plan — the week Ninja built from your real numbers, as a calendar.
//
// ponytail: no calendar dependency. This is a static 7-cell grid with a
// server-supplied Monday, not a date picker — CSS grid is the whole feature.

const DAY_LONG: Record<PlanDay, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

// VARC/DILR/QUANT reuse the app's one section vocabulary (lib/utils.ts) so a
// chip here matches the badge everywhere else. MIXED/REST aren't sections, so
// they get their own neutral looks rather than a fourth colour in that list.
function chipClass(section: PlanSection): string {
  if (section === "MIXED") return "bg-[#ffffff]/10 text-[#c5e8f0] border border-[#ffffff]/15";
  if (section === "REST") return "bg-[#7ab5cc]/10 text-[#7ab5cc] border border-[#7ab5cc]/25";
  return getSectionBadgeClass(section as CatSection);
}

// week_start is a plain DATE from Postgres ("2026-07-13", always a Monday).
// Parsed field-by-field on purpose: new Date("2026-07-13") is UTC midnight, so
// west-of-UTC users would render the whole week shifted one day early.
function dayLabel(weekStart: string | null, index: number): string {
  if (!weekStart) return "";
  const [y, m, d] = weekStart.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d + index);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isToday(weekStart: string | null, index: number): boolean {
  if (!weekStart) return false;
  const [y, m, d] = weekStart.split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d + index);
  const now = new Date();
  return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
}

export default function PlanClient({
  initialPlan, weekStart, initialRegens,
}: {
  initialPlan: StudyPlan | null;
  weekStart: string | null;
  initialRegens: number;
}) {
  const [plan, setPlan] = useState<StudyPlan | null>(initialPlan);
  const [week, setWeek] = useState<string | null>(weekStart);
  const [regens, setRegens] = useState(initialRegens);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (regenerate: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ninja/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Ninja could not build your plan");
        return;
      }
      setPlan(json.plan ?? null);
      setWeek(json.week_start ?? week);
      setRegens(json.regens ?? regens);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const totalMinutes = plan
    ? PLAN_DAYS.reduce((sum, d) => sum + (plan.days[d] ?? []).reduce((s, t) => s + t.minutes, 0), 0)
    : 0;

  return (
    <div className="min-h-screen bg-[#120F17] pb-8">
      <NinjaNav active="plan" />
      {/* Everything — heading and calendar — shares the lobby's max-w-5xl
          gutter, so no card breaks the container grid. */}
      <main className="max-w-5xl mx-auto px-4 pt-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="mr-auto min-w-0">
            <h1 className="font-pixel text-xl text-white">Study Plan</h1>
            <p className="text-xs text-[#7ab5cc] mt-1">
              {week ? `Week of ${dayLabel(week, 0)}` : "This week"}
              {plan && totalMinutes > 0 && ` · ${Math.round(totalMinutes / 60 * 10) / 10}h planned`}
            </p>
          </div>
          {plan && (
            <button
              onClick={() => generate(true)}
              disabled={busy || regens >= 1}
              title={regens >= 1 ? "One regenerate per week — a fresh plan unlocks Monday" : "Rebuild this week's plan"}
              className="flex items-center gap-2 rounded-lg border border-[#333333] px-3 py-2 text-xs font-semibold text-[#7ab5cc] transition hover:border-[#06d6a0] hover:text-[#06d6a0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
              {regens >= 1 ? "Regenerated" : "Regenerate"}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[#ef476f]/40 bg-[#ef476f]/10 px-3 py-2 text-sm text-[#ef476f]">
            <X size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!plan ? (
          <Empty busy={busy} onGenerate={() => generate(false)} />
        ) : (
          <>
            {(plan.diagnosis || plan.target) && (
              <div className="mb-5 grid gap-3 md:grid-cols-2">
                {plan.diagnosis && (
                  <div className="rounded-xl border border-[#1c1a24] bg-[#111111] p-4">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#4a8fa8]">Where you are</p>
                    <p className="text-sm leading-relaxed text-[#c5e8f0]">{plan.diagnosis}</p>
                  </div>
                )}
                {plan.target && (
                  <div className="rounded-xl border border-[#ffd166]/25 bg-[#111111] p-4">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#4a8fa8]">Target this week</p>
                    <p className="text-sm leading-relaxed text-[#ffd166]">{plan.target}</p>
                  </div>
                )}
              </div>
            )}

            {/* 7 columns on desktop; the week stacks on mobile rather than
                scrolling sideways — a 7-wide grid at 390px is unreadable. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
              {PLAN_DAYS.map((day, i) => {
                const tasks = plan.days[day] ?? [];
                const today = isToday(week, i);
                return (
                  <section
                    key={day}
                    className={`flex min-h-[180px] flex-col rounded-xl border bg-[#111111] p-3 ${
                      today ? "border-[#06d6a0]/60" : "border-[#1c1a24]"
                    }`}
                  >
                    <div className="mb-2 flex items-baseline justify-between">
                      <h2 className={`text-xs font-semibold ${today ? "text-[#06d6a0]" : "text-white"}`}>
                        <span className="lg:hidden">{DAY_LONG[day]}</span>
                        <span className="hidden lg:inline">{day}</span>
                      </h2>
                      <span className="text-[10px] text-[#4a8fa8]">{dayLabel(week, i)}</span>
                    </div>
                    <div className="flex flex-1 flex-col gap-2">
                      {tasks.length === 0 ? (
                        <p className="text-[11px] text-[#4a8fa8]">—</p>
                      ) : (
                        tasks.map((t, j) => (
                          <div key={j} className="rounded-lg border border-[#1c1a24] bg-[#120F17] p-2">
                            <div className="mb-1.5 flex items-center gap-1.5">
                              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${chipClass(t.section)}`}>
                                {t.section}
                              </span>
                              {t.minutes > 0 && (
                                <span className="text-[10px] text-[#4a8fa8]">{t.minutes}m</span>
                              )}
                            </div>
                            <p className="text-[11px] leading-snug text-[#c5e8f0]">{t.task}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>

            <p className="mt-4 text-center text-[10px] text-[#4a8fa8]">
              Built from your last 50 ranked matches. Ninja can be wrong — verify anything important.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Empty({ busy, onGenerate }: { busy: boolean; onGenerate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-[#1c1a24] bg-[#111111] px-6 py-20 text-center">
      <CalendarDays className="text-[#06d6a0]" size={36} />
      <div>
        <h2 className="text-lg font-semibold text-white">No plan for this week yet</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-[#7ab5cc]">
          Ninja reads your last 50 ranked matches — accuracy and pace per section, MCQ vs TITA, easy vs hard, and your
          ELO trend — then lays out seven days around what&apos;s actually costing you points.
        </p>
      </div>
      <button
        onClick={onGenerate}
        disabled={busy}
        className="flex items-center gap-2 rounded-xl bg-[#06d6a0] px-5 py-2.5 text-sm font-semibold text-[#073b4c] transition hover:brightness-105 disabled:opacity-40"
      >
        {busy ? <Loader2 className="animate-spin" size={16} /> : <CalendarDays size={16} />}
        {busy ? "Building your week…" : "Build my week"}
      </button>
      <p className="text-[10px] text-[#4a8fa8]">One plan per week. You can regenerate it once.</p>
    </div>
  );
}
