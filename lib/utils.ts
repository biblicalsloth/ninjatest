import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CatSection } from "@/lib/supabase/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMs(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  return `${secs}s`;
}

export function getSectionBadgeClass(section: CatSection): string {
  switch (section) {
    case "VARC": return "bg-blue-500/20 text-blue-300 border border-blue-500/30";
    case "DILR": return "bg-orange-500/20 text-orange-300 border border-orange-500/30";
    case "QUANT": return "bg-[#00ed64]/20 text-[#00ed64] border border-[#00ed64]/30";
    default: return "";
  }
}

export function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  return `${points}`;
}

export function getWinRate(wins: number, played: number): string {
  if (played === 0) return "0%";
  return `${Math.round((wins / played) * 100)}%`;
}

export function rankLabel(rank: number): string {
  if (rank === 1) return "#1";
  if (rank === 2) return "#2";
  if (rank === 3) return "#3";
  return `#${rank}`;
}
