"use client";

import Link from "next/link";
import { NinjatestLogo } from "@/components/ninja-logo";

type Screen = "chat" | "history" | "solve" | "plan";
type Mode = "coach" | "buddy";

const ITEMS: { key: Screen; label: string; href: string }[] = [
  { key: "chat", label: "Chat", href: "/ninja" },
  { key: "history", label: "History", href: "/ninja/history" },
  { key: "solve", label: "Solve a Paper", href: "/ninja/solve" },
  { key: "plan", label: "Study Plan", href: "/plan" },
];

const MODE_HINT: Record<Mode, string> = {
  coach: "Grounded in your real stats",
  buddy: "Socratic — Ninja guides, you solve",
};

/*
 * Shared top nav for the Ninja AI ecosystem — /ninja, /ninja/history,
 * /ninja/solve, /plan — and only those four. One seamless row: brand lockup
 * top-left in the lobby's max-w-5xl gutter, screen links right. The
 * Coach/Buddy toggle renders only when mode props are supplied (/ninja);
 * the other three screens omit it rather than showing a dead control.
 */
export function NinjaNav({
  active,
  mode,
  onModeChange,
  right,
}: {
  active: Screen;
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
  right?: React.ReactNode;
}) {
  return (
    <header className="w-full max-w-5xl mx-auto px-4 pt-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <NinjatestLogo />
        <nav aria-label="Ninja AI" className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          {mode && onModeChange && (
            <div className="flex rounded-full border border-[#1c1a24] bg-[#111111] p-0.5">
              {(["coach", "buddy"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => onModeChange(m)}
                  aria-pressed={mode === m}
                  title={MODE_HINT[m]}
                  className={`font-pixel rounded-full px-3 py-1 text-xs capitalize transition ${
                    mode === m ? "bg-[#06d6a0] text-[#073b4c]" : "text-[#7ab5cc] hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          {ITEMS.map((it) => (
            <Link
              key={it.key}
              href={it.href}
              aria-current={active === it.key ? "page" : undefined}
              className={`font-pixel text-sm transition ${
                active === it.key
                  ? "text-[#06d6a0] underline decoration-2 underline-offset-8"
                  : "text-[#7ab5cc] hover:text-white"
              }`}
            >
              {it.label}
            </Link>
          ))}
          {right}
        </nav>
      </div>
    </header>
  );
}
