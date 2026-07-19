"use client";

// Ninjatest motion vocabulary — the ONE identity, imported by every screen.
// Verdicts STAMP (scale-down landing + one-beat flash: matched, ±pts, win/loss,
// ELO delta). Everything else rises quietly on expo.out. Numbers roll like
// odometers (keep them tabular-nums). All entrances use gsap.from, so the
// prefersReduced() early-return leaves the DOM at its natural final state.

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export { gsap, useGSAP };

export const DUR = { snap: 0.18, base: 0.35, roll: 0.8 } as const;
export const EASE = {
  /** workhorse — fast start, decisive mechanical stop */
  out: "expo.out",
  /** small overshoot for badges/ratings settling into place */
  settle: "back.out(1.8)",
  /** the verdict stamp landing */
  stamp: "back.out(2.5)",
} as const;
export const STAGGER = 0.06;

/** Call first in every useGSAP and return early — motion-off users get the
 * final layout instantly (never slower tweens). */
export function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Quiet entrance: short rise, expo.out, staggered. Never blocks interaction
 * (opacity/transform only — elements stay clickable mid-tween). */
export function enterUp(targets: gsap.TweenTarget, vars: gsap.TweenVars = {}) {
  return gsap.from(targets, {
    y: 14,
    opacity: 0,
    duration: DUR.base,
    ease: EASE.out,
    stagger: STAGGER,
    clearProps: "transform,opacity",
    ...vars,
  });
}

/** The signature: a verdict stamps onto the page — slightly oversized, lands
 * with overshoot and a one-beat brightness flash. */
export function stamp(target: gsap.TweenTarget, vars: gsap.TweenVars = {}) {
  const tl = gsap.timeline();
  tl.from(target, {
    scale: 1.14,
    opacity: 0,
    duration: DUR.base,
    ease: EASE.stamp,
    ...vars,
  }).fromTo(
    target,
    { filter: "brightness(1.7)" },
    { filter: "brightness(1)", duration: 0.4, ease: "power2.out", clearProps: "filter" },
    "<0.05"
  );
  return tl;
}

/** Odometer roll from → to on an element's textContent (integer). */
export function countTo(
  el: Element,
  from: number,
  to: number,
  vars: gsap.TweenVars = {}
) {
  const state = { v: from };
  return gsap.to(state, {
    v: to,
    duration: DUR.roll,
    ease: EASE.out,
    onUpdate() {
      el.textContent = String(Math.round(state.v));
    },
    ...vars,
  });
}
