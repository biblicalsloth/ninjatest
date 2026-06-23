"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

export default function MatchError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("[match error]", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#001e2b] flex flex-col items-center justify-center gap-4 px-4 text-white">
      <AlertTriangle className="text-red-400" size={36} />
      <h2 className="text-lg font-semibold">Match error</h2>
      <p className="text-[#5c6c7a] text-sm text-center max-w-sm">{error.message || "Something went wrong during the match."}</p>
      <div className="flex gap-3 mt-2">
        <button
          onClick={reset}
          className="px-4 py-2 bg-[#1c2d38] text-white rounded-lg text-sm hover:bg-[#003d4f] transition-colors"
        >
          Try again
        </button>
        <Link href="/lobby" className="px-4 py-2 bg-[#00ed64] text-[#001e2b] rounded-lg text-sm font-semibold hover:bg-[#00b545] transition-colors">
          Back to lobby
        </Link>
      </div>
    </div>
  );
}
