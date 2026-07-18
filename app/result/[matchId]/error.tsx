"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

export default function ResultError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("[result error]", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center gap-4 px-4 text-white">
      <AlertTriangle className="text-[#ef476f]" size={36} />
      <h2 className="text-lg font-semibold">Failed to load result</h2>
      <p className="text-[#8a8a93] text-sm text-center max-w-sm">{error.message || "Could not load match result."}</p>
      <div className="flex gap-3 mt-2">
        <button
          onClick={reset}
          className="px-4 py-2 bg-[#1c1c1c] border border-[#222222] text-white rounded-lg text-sm hover:bg-[#222222] transition-colors"
        >
          Try again
        </button>
        <Link href="/lobby" className="px-4 py-2 bg-[#06d6a0] text-[#073b4c] rounded-lg text-sm font-semibold hover:bg-[#06d6a0]/90 transition-colors">
          Back to lobby
        </Link>
      </div>
    </div>
  );
}
