"use client";

import type { CatSection } from "@/lib/supabase/types";
import { formatMs } from "@/lib/utils";

interface Props {
  progress: number; // 1 = full, 0 = empty
  remaining: number; // ms
  size?: number;
  section: CatSection;
}

const SECTION_COLOR: Record<CatSection, string> = {
  VARC: "#118ab2",
  DILR: "#ffd166",
  QUANT: "#06d6a0",
};

export function CountdownRing({ progress, remaining, size = 56, section }: Props) {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, progress)));
  const color = SECTION_COLOR[section];

  const isUrgent = progress < 0.2;

  return (
    <div className={`relative${isUrgent ? " timer-urgent" : ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#111111"
          strokeWidth={stroke}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={isUrgent ? "#ef476f" : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.1s linear, stroke 0.3s" }}
        />
      </svg>
      {/* Center text */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          className="font-bold text-xs tabular-nums"
          style={{ color: isUrgent ? "#ef476f" : "white" }}
        >
          {formatMs(remaining)}
        </span>
      </div>
    </div>
  );
}
