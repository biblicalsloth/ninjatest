"use client";

import { useRouter } from "next/navigation";
import { NinjatestLogo } from "@/components/ninja-logo";

// Same roster the landing page shows, CAT live first.
const LIVE_EXAM = "CAT";
const EXAMS = ["CAT", "GMAT", "GRE", "LSAT", "JEE", "UPSC", "NEET", "MCAT", "SAT", "UCAT", "ACT", "TSA"];

// /exams — post-login funnel. Mirrors the mint auth panel (auth-panel.tsx):
// solid #06d6a0 backdrop, dark-ink card idiom, logo lockup on top. Only CAT
// is live; the rest render blurred and unselectable until their banks exist.
export default function ExamsClient() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06d6a0] px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <NinjatestLogo onMint className="mb-2" />
          <p className="text-[#120F17]/60 text-sm">Choose your exam.</p>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-6">
          {EXAMS.map((exam) => {
            const live = exam === LIVE_EXAM;
            return live ? (
              <div
                key={exam}
                aria-current="true"
                className="flex h-11 items-center justify-center rounded-xl bg-[#120F17] text-[#06d6a0] text-sm font-bold ring-2 ring-[#120F17]"
              >
                {exam}
              </div>
            ) : (
              <div
                key={exam}
                aria-disabled="true"
                title="Coming soon"
                className="flex h-11 items-center justify-center rounded-xl border border-[#120F17]/20 bg-[#120F17]/10 text-[#120F17]/50 text-sm font-semibold blur-[2px] select-none cursor-not-allowed"
              >
                {exam}
              </div>
            );
          })}
        </div>

        <p className="text-center text-[#120F17]/50 text-xs mb-5">
          CAT is live — the rest of the arena unlocks soon.
        </p>

        <button
          onClick={() => router.push("/lobby")}
          className="w-full h-11 bg-[#120F17] text-[#06d6a0] font-bold text-sm rounded-full hover:bg-[#120F17]/80 transition-colors"
        >
          Enter →
        </button>
      </div>
    </div>
  );
}
