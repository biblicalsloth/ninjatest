"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// One AI-personalized challenge line per day, under the lobby dailies.
// Cached server-side per (user, day): the RPC read is free; the generate call
// happens at most once a day. Renders nothing until resolved and stays hidden
// on any failure — the lobby must never wait on an LLM.
export function NinjaDailyFocus() {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any).rpc("get_ninja_daily_focus");
      const row = Array.isArray(data) ? data[0] : null;
      if (row?.content) {
        if (!cancelled) setContent(row.content);
        return;
      }
      try {
        const res = await fetch("/api/ninja/daily", { method: "POST" });
        const json = await res.json().catch(() => null);
        if (!cancelled && res.ok && json?.content) setContent(json.content);
      } catch {
        // stay hidden
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!content) return null;

  return (
    <div className="flex items-start gap-2.5 pt-2.5 mt-2.5 border-t border-[#222222]">
      <Sparkles size={16} className="text-[#06d6a0] shrink-0 mt-0.5" />
      <span className="text-sm text-[#c5e8f0]">
        {content}
        <span className="block text-[#4a8fa8] text-[11px] mt-0.5">Ninja&apos;s focus for today</span>
      </span>
    </div>
  );
}
