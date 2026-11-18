"use client";

import { useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { motion, type Variants } from "motion/react";
import { Zap, Users, Target, Loader2, X, ArrowRight } from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { C, Shuriken, Crown, Crescent } from "@/components/lobby-shapes";
import { cn } from "@/lib/utils";

// Lobby "Play" picker. One tile per mode; each tile is a mini pastel lobby card
// so the modal reads as the dashboard's own language, not a generic dialog.

export type PlayMode = "ranked" | "arena" | "practice";

interface Mode {
  id: PlayMode;
  name: string;
  blurb: string;
  chips: string[];
  color: string;
  icon: ReactNode;
  shape: ReactNode;
}

const MODES: Mode[] = [
  {
    id: "ranked",
    name: "Ranked 1v1",
    blurb: "Head-to-head against a player near your rating. Mixed VARC · DILR · Quant.",
    chips: ["9 Q", "ELO rated"],
    color: C.mint,
    icon: <Zap size={18} fill="currentColor" />,
    shape: <Shuriken color={C.mintTone} className="-right-8 -top-10 h-36 w-36" />,
  },
  {
    id: "arena",
    name: "Arena",
    blurb: "Up to 8 players, one question set. Finish order by score decides your rating swing.",
    chips: ["4–8 players", "Rated"],
    color: C.butter,
    icon: <Users size={18} />,
    shape: <Crown color={C.butterTone} className="-right-6 -top-6 h-32 w-32" />,
  },
  {
    id: "practice",
    name: "Practice drill",
    blurb: "Solo and unrated. Ninja starts you on your weakest section.",
    chips: ["Solo", "Unrated"],
    color: C.peri,
    icon: <Target size={18} />,
    shape: <Crescent color={C.periTone} className="-right-10 -top-10 h-36 w-36" />,
  },
];

const list: Variants = { show: { transition: { staggerChildren: 0.06, delayChildren: 0.06 } } };
const tile: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 260, damping: 24 } },
};

export function PlayDialog({
  open, onOpenChange, onPick, busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (mode: PlayMode) => void;
  /** Mode currently starting (shows a spinner, locks the other tiles). */
  busy: PlayMode | null;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent) {
    const n = Number(e.key);
    if (n >= 1 && n <= MODES.length) {
      e.preventDefault();
      if (!busy) onPick(MODES[n - 1].id);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const i = refs.current.findIndex((r) => r === document.activeElement);
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      refs.current[(Math.max(i, 0) + step + MODES.length) % MODES.length]?.focus();
      e.preventDefault();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/65 supports-backdrop-filter:backdrop-blur-md duration-200" />
        <DialogPrimitive.Popup
          onKeyDown={onKeyDown}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[760px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] bg-[#16131C] p-5 text-white shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)] ring-1 ring-white/10 outline-none duration-200 md:p-6 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {/* top mint hairline + glow: the modal's signature, same as the lobby rail */}
          <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#06d6a0]/70 to-transparent" />
          <span aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-80 -translate-x-1/2 rounded-full bg-[#06d6a0]/10 blur-3xl" />

          <div className="relative mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#06d6a0]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#06d6a0]" /> Choose your battle
              </p>
              <DialogTitle className="mt-1.5 font-pixel text-2xl font-normal leading-none md:text-3xl">Play</DialogTitle>
              <DialogDescription className="mt-2 text-[13px] text-white/55">
                Every mode serves 9 CAT questions on a server-timed clock.
              </DialogDescription>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </DialogPrimitive.Close>
          </div>

          <motion.div variants={list} initial="hidden" animate="show" className="relative grid grid-cols-1 gap-3 md:grid-cols-3">
            {MODES.map((m, i) => {
              const loading = busy === m.id;
              return (
                <motion.button
                  key={m.id}
                  ref={(el) => { refs.current[i] = el; }}
                  variants={tile}
                  whileHover={busy ? undefined : "hover"}
                  whileTap={busy ? undefined : { scale: 0.97 }}
                  onClick={() => !busy && onPick(m.id)}
                  disabled={!!busy && !loading}
                  aria-keyshortcuts={String(i + 1)}
                  style={{ backgroundColor: m.color }}
                  className="group relative isolate flex min-h-[176px] flex-col overflow-hidden rounded-[22px] p-4 text-left text-[#17131C] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#16131C] disabled:opacity-50 md:min-h-[232px]"
                >
                  <motion.span
                    aria-hidden
                    variants={{ hover: { rotate: 18, scale: 1.12 } }}
                    transition={{ type: "spring", stiffness: 200, damping: 14 }}
                    className="pointer-events-none absolute inset-0 -z-10"
                  >
                    {m.shape}
                  </motion.span>

                  <span className="flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#17131C]" style={{ color: m.color }}>
                      {loading ? <Loader2 size={18} className="animate-spin" /> : m.icon}
                    </span>
                    <kbd className="rounded-md bg-[#17131C]/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold">{i + 1}</kbd>
                  </span>

                  <span className="mt-4 block font-pixel text-xl leading-tight">{loading ? "Starting…" : m.name}</span>
                  <span className="mt-1.5 block text-[12.5px] leading-snug opacity-75">{m.blurb}</span>

                  <span className="mt-auto flex items-end justify-between gap-2 pt-4">
                    <span className="flex flex-wrap gap-1">
                      {m.chips.map((c) => (
                        <span key={c} className="rounded-full bg-[#17131C] px-2 py-0.5 text-[10px] font-semibold text-white">{c}</span>
                      ))}
                    </span>
                    <motion.span
                      variants={{ hover: { x: 3 } }}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#17131C]/10"
                    >
                      <ArrowRight size={14} />
                    </motion.span>
                  </span>
                </motion.button>
              );
            })}
          </motion.div>

          <p className={cn("relative mt-4 hidden text-center text-[11px] text-white/35 md:block")}>
            Press <kbd className="font-mono text-white/60">1</kbd>–<kbd className="font-mono text-white/60">3</kbd> to pick ·{" "}
            <kbd className="font-mono text-white/60">Esc</kbd> to close
          </p>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
