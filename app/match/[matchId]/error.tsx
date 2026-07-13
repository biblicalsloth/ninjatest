"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

export default function MatchError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("[match error]", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center gap-4 px-4 text-white">
      <AlertTriangle className="text-[#ef476f]" size={36} />
      <h2 className="text-lg font-semibold">Match error</h2>
      <p className="text-white/50 text-sm text-center max-w-sm">{error.message || "Something went wrong during the match."}</p>
      <div className="flex gap-3 mt-2">
        <button
          onClick={reset}
          className="px-5 py-2 bg-white/10 text-white rounded-full text-sm hover:bg-white/20 transition-colors"
        >
          Try again
        </button>
        <Link href="/lobby" className="px-5 py-2 bg-[#06d6a0] text-[#120F17] rounded-full text-sm font-semibold hover:bg-[#06d6a0]/80 transition-colors">
          Back to lobby
        </Link>
      </div>
    </div>
  );
}
