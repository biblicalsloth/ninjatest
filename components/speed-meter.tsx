"use client";

import type { CatSection } from "@/lib/supabase/types";

interface Props {
  progress: number; // 1 = full time remaining, 0 = cap reached
  section: CatSection;
  capMs: number;
  timeRemaining: number;
}

const SECTION_MULT: Record<CatSection, number> = { VARC: 1, DILR: 2, QUANT: 2 };
const GRACE_BLOCK = 5000;

export function SpeedMeter({ progress, section, capMs, timeRemaining }: Props) {
  const mult = SECTION_MULT[section];
  const graceBlocks = Math.floor(timeRemaining / GRACE_BLOCK);
  const gracePoints = graceBlocks * mult;
  const maxGrace = Math.floor(capMs / GRACE_BLOCK) * mult;
  const pct = maxGrace > 0 ? gracePoints / maxGrace : 0;

  const isUrgent = progress < 0.2;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#7ab5cc]">Speed bonus</span>
        <span className={`font-semibold tabular-nums ${isUrgent ? "text-[#ef476f]" : "text-[#ffd166]"}`}>
          +{gracePoints} pts
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[#0a4f66] overflow-hidden">
        <div
          className="h-full rounded-full transition-[width,background-color] duration-100"
          style={{
            width: `${pct * 100}%`,
            backgroundColor: isUrgent ? "#ef476f" : "#ffd166",
          }}
        />
      </div>
      <p className="text-[#7ab5cc] text-xs">
        Answer faster → more bonus points · ×{mult} speed mult
      </p>
    </div>
  );
}
