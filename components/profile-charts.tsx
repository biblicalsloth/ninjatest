"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";

// Fed by get_section_stats: one row per section the player has answered.
interface SectionStat {
  section: "VARC" | "DILR" | "QUANT";
  accuracy: number;   // 0–100
  avg_points: number; // per-question, can be negative
}

const LABEL: Record<string, string> = { VARC: "Verbal", DILR: "Logical", QUANT: "Quant" };
const COLOR: Record<string, string> = { VARC: "#7ab5cc", DILR: "#ffd166", QUANT: "#06d6a0" };
const ORDER = ["VARC", "DILR", "QUANT"] as const;

const TOOLTIP = {
  backgroundColor: "#0a4f66",
  border: "1px solid #2a7a9a",
  borderRadius: 8,
  color: "#ffffff",
  fontSize: 12,
} as const;

/* Bar — avg points earned per question, by section (scoring output). */
export function SectionPointsBar({ stats }: { stats: SectionStat[] }) {
  const data = stats.map((s) => ({ name: LABEL[s.section] ?? s.section, section: s.section, pts: s.avg_points }));
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fill: "#7ab5cc", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "#7ab5cc", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "#ffffff08" }}
            contentStyle={TOOLTIP}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(v: any) => [`${v > 0 ? "+" : ""}${v}`, "Avg pts/Q"]}
          />
          <Bar dataKey="pts" radius={[4, 4, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.section} fill={COLOR[d.section] ?? "#06d6a0"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Radar — accuracy % across the three sections (skill shape). */
export function SectionAccuracyRadar({ stats }: { stats: SectionStat[] }) {
  const bySection = new Map(stats.map((s) => [s.section, s.accuracy]));
  const data = ORDER.map((sec) => ({ section: LABEL[sec], accuracy: bySection.get(sec) ?? 0 }));
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <PolarGrid stroke="#222222" />
          <PolarAngleAxis dataKey="section" tick={{ fill: "#c5e8f0", fontSize: 12 }} />
          <PolarRadiusAxis domain={[0, 100]} tick={{ fill: "#4a8fa8", fontSize: 10 }} axisLine={false} />
          <Radar dataKey="accuracy" stroke="#06d6a0" fill="#06d6a0" fillOpacity={0.35} />
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Tooltip contentStyle={TOOLTIP} formatter={(v: any) => [`${v}%`, "Accuracy"]} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
