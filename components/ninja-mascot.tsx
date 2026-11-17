"use client";

import { useEffect, useRef } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

/*
 * Ninja Hanzo — the Ask Ninja mascot. Built on NinjaLogo's geometry
 * (components/ninja-logo.tsx): headwrap rect on top, mask rect below, the two
 * eye slits in the gap — here opened up into white eyes on a mint face, plus
 * headband tails. Animated: idle bob, blink, tail sway, pupils follow the
 * cursor. Static when `animated={false}` or the OS asks for reduced motion.
 */
const INK = "#073b4c";
const MINT = "#06d6a0";

export function NinjaMascot({ size = 112, animated = true, className }: { size?: number; animated?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const live = animated && !reduce;
  const ref = useRef<SVGSVGElement>(null);
  // Pupil offset in viewBox units, springed so tracking feels alive, not twitchy.
  const px = useSpring(useMotionValue(0), { stiffness: 200, damping: 20 });
  const py = useSpring(useMotionValue(0), { stiffness: 200, damping: 20 });

  useEffect(() => {
    if (!live) return;
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 300); // full deflection ~300px away
      px.set((dx / d) * 2.2 * k);
      py.set((dy / d) * 1.4 * k);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [live, px, py]);

  const eye = (cx: number) => (
    <motion.g
      style={{ originX: `${cx}px`, originY: "50px", transformBox: "view-box" }}
      animate={live ? { scaleY: [1, 1, 0.1, 1, 1] } : undefined}
      transition={live ? { duration: 4, times: [0, 0.9, 0.93, 0.96, 1], repeat: Infinity } : undefined}
    >
      <ellipse cx={cx} cy={50} rx={11} ry={8} fill="#fff" />
      <motion.circle cx={cx} cy={50} r={4.6} fill={INK} style={{ x: px, y: py }} />
      <circle cx={cx + 1.6} cy={48.2} r={1.4} fill="#fff" />
    </motion.g>
  );

  return (
    <motion.svg
      ref={ref}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Ninja Hanzo"
      style={animated ? { filter: "drop-shadow(0 10px 24px rgba(6,214,160,0.35))", overflow: "visible" } : undefined}
      animate={live ? { y: [0, -4, 0] } : undefined}
      transition={live ? { duration: 3, ease: "easeInOut", repeat: Infinity } : undefined}
    >
      {/* Headband tails — sway from the knot on the right */}
      <motion.g
        style={{ originX: "86px", originY: "26px", transformBox: "view-box" }}
        animate={live ? { rotate: [0, 10, -4, 0] } : undefined}
        transition={live ? { duration: 2.4, ease: "easeInOut", repeat: Infinity } : undefined}
      >
        <path d="M84 22 C95 16 101 24 99 34 C95 29 90 29 84 30 Z" fill={MINT} />
        <path d="M84 27 C94 31 97 41 92 48 C90 41 86 36 82 33 Z" fill={MINT} fillOpacity={0.75} />
      </motion.g>
      {/* Face */}
      <rect x={10} y={8} width={78} height={84} rx={22} fill={MINT} />
      {/* Headwrap (logo top rect) */}
      <path d="M10 38 V30 A22 22 0 0 1 32 8 H66 A22 22 0 0 1 88 30 V38 Z" fill={INK} />
      {/* Forehead plate (hitai-ate) */}
      <rect x={36} y={17} width={26} height={11} rx={3} fill={MINT} />
      <path d="M43 22.5 H55" stroke={INK} strokeWidth={2} strokeLinecap="round" />
      {/* Mask (logo bottom rect) */}
      <path d="M10 62 H88 V70 A22 22 0 0 1 66 92 H32 A22 22 0 0 1 10 70 Z" fill={INK} />
      {/* Brows — a little determined */}
      <path d="M22 41 L38 43" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      <path d="M76 41 L60 43" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      {eye(32)}
      {eye(66)}
      {/* Mask fold line */}
      <path d="M30 75 Q49 81 68 75" stroke={MINT} strokeOpacity={0.35} strokeWidth={2} fill="none" strokeLinecap="round" />
    </motion.svg>
  );
}
