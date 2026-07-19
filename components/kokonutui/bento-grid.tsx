"use client";

/**
 * Bento Grid — trimmed from KokonutUI's bento-grid (MIT, @dorianbaffier,
 * kokonutui.com) and restyled to the ninjatest brand. Keeps the pattern
 * (3D tilt cards, staggered reveal, per-card feature slots); the demo
 * features (provider icons, typing code, voice assistant) are deleted and
 * the content is ninjatest's. Lives on the landing page, so the section
 * wrapper stays transparent — the Grainient gradient must show through.
 */

import { CheckCircle2 } from "lucide-react";
import {
  motion,
  useMotionValue,
  useTransform,
  type Variants,
} from "motion/react";
import { useEffect, useState } from "react";

interface BentoItem {
  id: string;
  title: string;
  description: string;
  feature: "spotlight" | "counter" | "timeline" | "metrics";
  spotlightItems?: string[];
  timeline?: Array<{ year: string; event: string }>;
  metrics?: Array<{ label: string; value: number; suffix?: string; color: string }>;
  statistic?: { label: string; start: number; end: number; suffix?: string };
}

const bentoItems: BentoItem[] = [
  {
    id: "arena",
    title: "The whole arena",
    description: "Everything a rated battle needs, checked by the server — never the client.",
    feature: "spotlight",
    spotlightItems: [
      "ELO-banded matchmaking",
      "Self-paced per-player clocks",
      "Live spectate mode",
      "Seasons, leagues & win streaks",
      "Friend challenges, rated or casual",
    ],
  },
  {
    id: "speed",
    title: "Speed pays",
    description: "Answer fast, score more. Guessing is EV-neutral by construction — the penalty rides the same speed curve.",
    feature: "counter",
    statistic: { label: "max per question, every section", start: 0, end: 140, suffix: " pts" },
  },
  {
    id: "clocks",
    title: "Section clocks",
    description: "Tuned per section, capped per question, measured server-side.",
    feature: "metrics",
    metrics: [
      { label: "VARC", value: 90, suffix: "s", color: "#06d6a0" },
      { label: "Quant", value: 105, suffix: "s", color: "#ffd166" },
      { label: "DILR", value: 120, suffix: "s", color: "#ef476f" },
    ],
  },
  {
    id: "loop",
    title: "One battle, start to finish",
    description: "The whole loop takes minutes — the rating sticks.",
    feature: "timeline",
    timeline: [
      { year: "01", event: "Queue — matched at your level in seconds" },
      { year: "02", event: "Battle — nine questions on your own clock" },
      { year: "03", event: "Debrief — Ninja explains the swing moments" },
      { year: "04", event: "Climb — zero-sum ELO, honest ranks" },
    ],
  },
];

const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.15, delayChildren: 0.3 },
  },
};

const SpotlightFeature = ({ items }: { items: string[] }) => (
  <ul className="mt-2 space-y-1.5">
    {items.map((item, index) => (
      <motion.li
        animate={{ opacity: 1, x: 0 }}
        className="flex items-center gap-2"
        initial={{ opacity: 0, x: -10 }}
        key={`spotlight-${item.toLowerCase().replace(/\s+/g, "-")}`}
        transition={{ delay: 0.1 * index }}
      >
        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[#06d6a0]" />
        <span className="text-[#c5e8f0]/80 text-sm">{item}</span>
      </motion.li>
    ))}
  </ul>
);

const CounterAnimation = ({
  start,
  end,
  suffix = "",
}: {
  start: number;
  end: number;
  suffix?: string;
}) => {
  const [count, setCount] = useState(start);

  useEffect(() => {
    const duration = 2000;
    const frameRate = 1000 / 60;
    const totalFrames = Math.round(duration / frameRate);

    let currentFrame = 0;
    const counter = setInterval(() => {
      currentFrame++;
      const progress = currentFrame / totalFrames;
      const easedProgress = 1 - (1 - progress) ** 3;
      const current = start + (end - start) * easedProgress;

      setCount(Math.min(current, end));

      if (currentFrame === totalFrames) {
        clearInterval(counter);
      }
    }, frameRate);

    return () => clearInterval(counter);
  }, [start, end]);

  return (
    <div className="flex items-baseline gap-1">
      <span className="font-pixel text-3xl text-[#ffd166]">
        {count.toFixed(1).replace(/\.0$/, "")}
      </span>
      <span className="font-pixel text-[#ffd166]/80 text-xl">{suffix}</span>
    </div>
  );
};

const TimelineFeature = ({
  timeline,
}: {
  timeline: Array<{ year: string; event: string }>;
}) => (
  <div className="relative mt-3">
    <div className="absolute top-0 bottom-0 left-[9px] w-[2px] bg-white/10" />
    {timeline.map((item, index) => (
      <motion.div
        animate={{ opacity: 1, x: 0 }}
        className="relative mb-3 flex gap-3"
        initial={{ opacity: 0, x: -10 }}
        key={`timeline-${item.year}`}
        transition={{ delay: 0.15 * index }}
      >
        <div className="z-10 mt-0.5 h-5 w-5 flex-shrink-0 rounded-full border-2 border-[#06d6a0]/40 bg-[#120F17]" />
        <div>
          <div className="font-mono text-[#06d6a0] text-xs">{item.year}</div>
          <div className="text-[#7ab5cc] text-xs">{item.event}</div>
        </div>
      </motion.div>
    ))}
  </div>
);

const MetricsFeature = ({
  metrics,
}: {
  metrics: Array<{ label: string; value: number; suffix?: string; color: string }>;
}) => (
  <div className="mt-3 space-y-3">
    {metrics.map((metric, index) => (
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="space-y-1"
        initial={{ opacity: 0, y: 10 }}
        key={`metric-${metric.label.toLowerCase()}`}
        transition={{ delay: 0.15 * index }}
      >
        <div className="flex items-center justify-between text-sm">
          <div className="font-medium text-[#c5e8f0]/80">{metric.label}</div>
          <div className="font-mono text-[#c5e8f0]/80">
            {metric.value}
            {metric.suffix}
          </div>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <motion.div
            animate={{ width: `${Math.min(100, (metric.value / 120) * 100)}%` }}
            className="h-full rounded-full"
            initial={{ width: 0 }}
            style={{ backgroundColor: metric.color }}
            transition={{ duration: 1.2, ease: "easeOut", delay: 0.15 * index }}
          />
        </div>
      </motion.div>
    ))}
  </div>
);

const BentoCard = ({ item }: { item: BentoItem }) => {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useTransform(y, [-100, 100], [2, -2]);
  const rotateY = useTransform(x, [-100, 100], [-2, 2]);

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const xPct = (event.clientX - rect.left) / rect.width - 0.5;
    const yPct = (event.clientY - rect.top) / rect.height - 0.5;
    x.set(xPct * 100);
    y.set(yPct * 100);
  }

  function handleMouseLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.div
      className="h-full"
      onHoverEnd={handleMouseLeave}
      onMouseMove={handleMouseMove}
      style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      variants={fadeInUp}
      whileHover={{ y: -5 }}
    >
      <div className="group relative flex h-full flex-col gap-3 rounded-xl border border-[#222222] bg-white/[0.03] p-5 backdrop-blur-[4px] transition-colors duration-500 hover:border-[#06d6a0]/30 hover:bg-white/[0.05]">
        <div
          className="relative z-10 flex h-full flex-col space-y-2"
          style={{ transform: "translateZ(20px)" }}
        >
          <h3 className="font-pixel text-lg text-white">{item.title}</h3>
          <p className="text-[#c5e8f0]/60 text-sm leading-relaxed">
            {item.description}
          </p>

          {item.feature === "spotlight" && item.spotlightItems && (
            <SpotlightFeature items={item.spotlightItems} />
          )}

          {item.feature === "counter" && item.statistic && (
            <div className="mt-auto pt-3">
              <CounterAnimation
                end={item.statistic.end}
                start={item.statistic.start}
                suffix={item.statistic.suffix}
              />
              <p className="mt-1 text-[#7ab5cc] text-xs">{item.statistic.label}</p>
            </div>
          )}

          {item.feature === "timeline" && item.timeline && (
            <TimelineFeature timeline={item.timeline} />
          )}

          {item.feature === "metrics" && item.metrics && (
            <MetricsFeature metrics={item.metrics} />
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default function BentoGrid() {
  return (
    <motion.div
      className="grid gap-4"
      initial="hidden"
      variants={staggerContainer}
      viewport={{ once: true }}
      whileInView="visible"
    >
      <div className="grid gap-4 md:grid-cols-3">
        <motion.div className="md:col-span-2" variants={fadeInUp}>
          <BentoCard item={bentoItems[0]} />
        </motion.div>
        <motion.div className="md:col-span-1" variants={fadeInUp}>
          <BentoCard item={bentoItems[1]} />
        </motion.div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <motion.div variants={fadeInUp}>
          <BentoCard item={bentoItems[2]} />
        </motion.div>
        <motion.div variants={fadeInUp}>
          <BentoCard item={bentoItems[3]} />
        </motion.div>
      </div>
    </motion.div>
  );
}
