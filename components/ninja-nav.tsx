"use client";

import Link from "next/link";
import { motion } from "motion/react";
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

const SPRING = { type: "spring", stiffness: 400, damping: 32 } as const;

/*
 * Shared top nav for the Ninja AI ecosystem — /ninja, /ninja/history,
 * /ninja/solve, /plan — and only those four. One seamless row: brand lockup
 * top-left in the lobby's max-w-5xl gutter, screen links right. The
 * Coach/Buddy toggle renders only when mode props are supplied (/ninja);
 * the other three screens omit it rather than showing a dead control.
 *
 * The item cluster reserves the chat rail's width (md:mr-72) on EVERY page,
 * not just /ninja — one true position for the links across the ecosystem,
 * and on /ninja it's what keeps them clear of the rail at any viewport.
 *
 * Links use the Kokonut UI Morphic Navbar geometry: a joined capsule strip
 * where the ACTIVE item pops out as its own mint pill and the adjacent
 * segments round their corners to make room. The pill tracks only the
 * active screen — hover/focus merely recolor text. Navigation remounts the
 * page, so the pill's layout spring rarely runs visibly; that's accepted.
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
  const activeIdx = ITEMS.findIndex((it) => it.key === active);

  return (
    <header className="w-full max-w-5xl mx-auto px-4 pt-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <NinjatestLogo />
        <nav aria-label="Ninja AI" className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 md:mr-72">
          {mode && onModeChange && (
            <div className="flex rounded-full border border-[#1c1a24] bg-[#111111] p-0.5">
              {(["coach", "buddy"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => onModeChange(m)}
                  aria-pressed={mode === m}
                  title={MODE_HINT[m]}
                  className="relative font-pixel rounded-full px-3 py-1 text-xs capitalize"
                >
                  {mode === m && (
                    <motion.span
                      layoutId="ninja-mode-pill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-full bg-[#06d6a0]"
                    />
                  )}
                  <span
                    className={`relative transition-colors ${
                      mode === m ? "text-[#073b4c]" : "text-[#7ab5cc] hover:text-white"
                    }`}
                  >
                    {m}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center overflow-hidden rounded-full border border-[#1c1a24]">
            {ITEMS.map((it, i) => {
              const isActive = active === it.key;
              const roundL = i === 0 || activeIdx === i - 1;
              const roundR = i === ITEMS.length - 1 || activeIdx === i + 1;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`group relative font-pixel text-sm px-3 py-1.5 md:px-4 cursor-pointer ${
                    isActive
                      ? "mx-1.5 rounded-full"
                      : `bg-[#111111] ${roundL ? "rounded-l-full" : ""} ${
                          roundR ? "rounded-r-full" : ""
                        }`
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="ninja-nav-pill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-full bg-[#06d6a0]"
                    />
                  )}
                  <span
                    className={`relative transition-colors ${
                      isActive
                        ? "text-[#073b4c]"
                        : "text-[#7ab5cc] hover:text-white group-focus-visible:text-white"
                    }`}
                  >
                    {it.label}
                  </span>
                </Link>
              );
            })}
          </div>
          {right}
        </nav>
      </div>
    </header>
  );
}
