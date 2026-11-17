"use client";

/**
 * Feature bento — 3×2, one card per thing the product actually does.
 * Rewritten 2026-07-26: the KokonutUI 3D-tilt/backdrop-blur treatment is gone
 * (it fought the Grainient gradient behind it and read as glassy demo chrome).
 * Now flat #111111 cards with a mono index, a pixel title, plain-English copy
 * and one small visual each. The section wrapper stays transparent — the
 * gradient must show through around the cards.
 */

import { motion, type Variants } from "motion/react";
import { Bot, Brain, Library, MessageSquare, Swords, Target } from "lucide-react";

const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" } },
};

const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};

/* ── Per-card visuals ── */

function MatchVisual() {
  return (
    <div className="flex items-center gap-3">
      <Face initials="YOU" color="#06d6a0" />
      <div className="flex-1 h-px bg-gradient-to-r from-[#06d6a0]/50 via-[#333333] to-[#ffd166]/50" />
      <span className="font-pixel text-[10px] text-[#7ab5cc]">VS</span>
      <div className="flex-1 h-px bg-gradient-to-r from-[#ffd166]/50 via-[#333333] to-[#06d6a0]/50" />
      <Face initials="RIV" color="#ffd166" />
    </div>
  );
}

function Face({ initials, color }: { initials: string; color: string }) {
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full font-pixel text-[9px]"
      style={{ color, background: `${color}1a`, border: `1px solid ${color}40` }}
    >
      {initials}
    </span>
  );
}

function BankVisual() {
  // Three stacked bars — the bank is deep in every section, not just one.
  const rows = [
    { label: "Verbal", color: "#118ab2", pct: 88 },
    { label: "Logic", color: "#ffd166", pct: 72 },
    { label: "Quant", color: "#06d6a0", pct: 96 },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div className="flex items-center gap-2.5" key={r.label}>
          <span className="w-12 shrink-0 font-mono text-[10px]" style={{ color: r.color }}>
            {r.label}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/8">
            <motion.div
              className="h-full rounded-full"
              initial={{ width: 0 }}
              style={{ background: r.color }}
              transition={{ duration: 1, ease: "easeOut" }}
              viewport={{ once: true }}
              whileInView={{ width: `${r.pct}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function BuddyVisual() {
  return (
    <div className="space-y-2">
      <Bubble side="right" text="Just tell me the answer." tone="#7ab5cc" />
      <Bubble side="left" text="Not yet. What did the second clue rule out?" tone="#9f84bd" />
    </div>
  );
}

function CoachVisual() {
  return (
    <div className="space-y-2">
      <Bubble side="right" text="Why am I stuck?" tone="#7ab5cc" />
      <Bubble side="left" text="You're fine on accuracy. You lose on pace — 18s slower per question this week." tone="#06d6a0" />
    </div>
  );
}

function Bubble({ side, text, tone }: { side: "left" | "right"; text: string; tone: string }) {
  return (
    <div className={`flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <p
        className="max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed"
        style={
          side === "right"
            ? { background: "#1c1c1c", color: "#c5e8f0" }
            : { background: `${tone}14`, border: `1px solid ${tone}33`, color: "#c5e8f0" }
        }
      >
        {text}
      </p>
    </div>
  );
}

function DrillVisual() {
  const rows = [
    { s: "Logic", c: "#ffd166", t: "Seating puzzles" },
    { s: "Verbal", c: "#118ab2", t: "Main-idea questions" },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div className="flex items-center gap-2.5 rounded-lg bg-[#1c1c1c] px-3 py-2" key={r.t}>
          <span className="font-mono text-[10px] shrink-0" style={{ color: r.c }}>
            {r.s}
          </span>
          <span className="flex-1 truncate text-[#c5e8f0] text-xs">{r.t}</span>
          <span className="font-mono text-[10px] text-[#4a8fa8]">10 Qs</span>
        </div>
      ))}
    </div>
  );
}

function PlanVisual() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div className="flex gap-1.5">
      {days.map((d, i) => (
        <div className="flex-1 text-center" key={`${d}-${i}`}>
          <div
            className="h-8 rounded-md"
            style={{
              background: i < 4 ? "#06d6a01f" : "#ffffff08",
              border: i < 4 ? "1px solid #06d6a03d" : "1px solid #ffffff12",
            }}
          />
          <span className="mt-1 block font-mono text-[9px] text-[#4a8fa8]">{d}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Cards ── */

const CARDS = [
  {
    id: "01",
    icon: Swords,
    accent: "#06d6a0",
    title: "Ranked mode",
    body: "One tap puts you in a live 1v1 against someone at your level. Nine questions, both clocks running, a winner at the end. Win and your rating goes up by exactly what theirs goes down.",
    visual: <MatchVisual />,
  },
  {
    id: "02",
    icon: Library,
    accent: "#118ab2",
    title: "A question bank that watches back",
    body: "Thousands of questions, every one with its own difficulty score that moves as people play it. You get served the ones that are genuinely hard for you — not too easy, not hopeless.",
    visual: <BankVisual />,
  },
  {
    id: "03",
    icon: Brain,
    accent: "#9f84bd",
    title: "Buddy mode — hints, never answers",
    body: "Stuck on a question? Buddy asks you questions back until you get there yourself. It will not hand you the solution, because being told is not the same as knowing.",
    visual: <BuddyVisual />,
  },
  {
    id: "04",
    icon: MessageSquare,
    accent: "#06d6a0",
    title: "Coach mode — straight answers about you",
    body: "Ask anything about your own prep and get a reply built on your actual results. No pep talk, no generic tips — it can see your scores, so it tells you what they say.",
    visual: <CoachVisual />,
  },
  {
    id: "05",
    icon: Target,
    accent: "#ffd166",
    title: "Practice made from your mistakes",
    body: "Solo drills assembled from the things you keep getting wrong. Nothing is rated, nothing counts against you — it is the range, not the match.",
    visual: <DrillVisual />,
  },
  {
    id: "06",
    icon: Bot,
    accent: "#06d6a0",
    title: "A week you can actually follow",
    body: "One realistic seven-day plan, rebuilt when your results move. Short days, honest targets, and it tells you which day matters most.",
    visual: <PlanVisual />,
  },
];

function BentoCard({ card }: { card: (typeof CARDS)[number] }) {
  const Icon = card.icon;
  return (
    <motion.div className="h-full" variants={fadeInUp}>
      <div className="group flex h-full flex-col rounded-2xl border border-[#222222] bg-[#111111] p-6 transition-colors duration-300 hover:border-[#06d6a0]/35">
        <div className="mb-5 flex items-center justify-between">
          <span
            className="grid h-9 w-9 place-items-center rounded-lg"
            style={{ background: `${card.accent}14`, border: `1px solid ${card.accent}33` }}
          >
            <Icon size={16} style={{ color: card.accent }} />
          </span>
          <span className="font-mono text-[10px] text-[#333333] transition-colors group-hover:text-[#4a8fa8]">
            {card.id}
          </span>
        </div>

        <h3 className="font-pixel text-lg leading-snug text-white">{card.title}</h3>
        <p className="mt-3 text-[#7ab5cc] text-sm leading-relaxed">{card.body}</p>

        <div className="mt-6 border-t border-[#222222] pt-5">{card.visual}</div>
      </div>
    </motion.div>
  );
}

export default function BentoGrid() {
  return (
    <motion.div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      initial="hidden"
      variants={staggerContainer}
      viewport={{ once: true, amount: 0.15 }}
      whileInView="visible"
    >
      {CARDS.map((c) => (
        <BentoCard card={c} key={c.id} />
      ))}
    </motion.div>
  );
}
