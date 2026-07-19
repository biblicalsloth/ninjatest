"use client";

import Link from "next/link";
import { useState } from "react";
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

const MotionLink = motion.create(Link);

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
 * where the highlighted item pops out as its own mint pill and the adjacent
 * segments round their corners to make room. Navigation remounts the page,
 * so the morph tracks hover (falling back to the active screen) — that's
 * what makes the motion spring actually visible.
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
  const [hovered, setHovered] = useState<Screen | null>(null);
  const shown = hovered ?? active;
  const shownIdx = ITEMS.findIndex((it) => it.key === shown);

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
          <div
            className="flex items-center overflow-hidden rounded-full border border-[#1c1a24]"
            onMouseLeave={() => setHovered(null)}
          >
            {ITEMS.map((it, i) => {
              const isShown = shown === it.key;
              const roundL = i === 0 || shownIdx === i - 1;
              const roundR = i === ITEMS.length - 1 || shownIdx === i + 1;
              return (
                <MotionLink
                  key={it.key}
                  href={it.href}
                  layout
                  transition={SPRING}
                  onMouseEnter={() => setHovered(it.key)}
                  onFocus={() => setHovered(it.key)}
                  onBlur={() => setHovered(null)}
                  aria-current={active === it.key ? "page" : undefined}
                  className={`font-pixel text-sm px-3 py-1.5 md:px-4 transition-[border-radius,background-color,color] duration-300 ${
                    isShown
                      ? "mx-1.5 rounded-full bg-[#06d6a0] text-[#073b4c]"
                      : `bg-[#111111] text-[#7ab5cc] hover:text-white ${roundL ? "rounded-l-full" : ""} ${
                          roundR ? "rounded-r-full" : ""
                        }`
                  }`}
                >
                  {it.label}
                </MotionLink>
              );
            })}
          </div>
          {right}
        </nav>
      </div>
    </header>
  );
}
