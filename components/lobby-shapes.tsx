"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

// Lobby palette ("tuned to mint"): pastel cards on the dark #120F17 page, dark
// ink on top. Mint stays the only CTA colour. Each pastel also carries a deeper
// tone of its own hue for the decorative shape bleeding off its corner.
export const C = {
  ink: "#17131C",
  mint: "#06d6a0", mintTone: "#05b088",
  butter: "#F5D96B", butterTone: "#EBC53E",
  rose: "#F7BFD8", roseTone: "#EE9EC3",
  sage: "#B7C97A", sageTone: "#9DB35A",
  peri: "#A9BDF2", periTone: "#8AA4EA",
} as const;

/* Decorative shapes (ninja / CAT). Absolutely positioned — the caller sizes
   and places them via className. */

type ShapeProps = { color: string; className?: string };

export function Shuriken({ color, className, spin }: ShapeProps & { spin?: boolean }) {
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

export function Crown({ color, className }: ShapeProps) {
  return (
    <motion.svg viewBox="0 0 100 100" className={cn("absolute", className)} animate={{ rotate: [-8, -2, -8] }} transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}>
      <path fill={color} d="M8 82 L4 28 L30 50 L50 10 L70 50 L96 28 L92 82 Q50 92 8 82Z" />
    </motion.svg>
  );
}

// Katana arc — a crescent sweep.
export function Crescent({ color, className }: ShapeProps) {
  return (
    <motion.svg viewBox="0 0 100 100" className={cn("absolute", className)} animate={{ rotate: [0, 10, 0] }} transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}>
      <path fill={color} d="M30 6 A46 46 0 1 0 94 70 A40 40 0 1 1 30 6Z" />
    </motion.svg>
  );
}

export function Burst({ color, className }: ShapeProps) {
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

export function FlameShape({ color, className }: ShapeProps) {
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
