"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

// Result-page debrief card. Shows the cached debrief instantly if one exists;
// otherwise a one-tap generate. The route caches server-side, so mashing the
// button never bills twice.
export function NinjaDebrief({ matchId }: { matchId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_ninja_debrief", { p_match_id: matchId })
      .then(({ data }: { data: { content: string }[] | null }) => {
        if (data?.[0]?.content) setContent(data[0].content);
        setChecked(true);
      });
  }, [matchId]);

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch("/api/ninja/debrief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_id: matchId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setContent(data.content);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!checked) return null;

  return (
    <div className="bg-[#111111] rounded-xl p-5">
      <h3 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Sparkles size={12} className="text-[#06d6a0]" /> Ninja debrief
      </h3>
      {content ? (
        <p className="text-[#c5e8f0] text-sm whitespace-pre-line leading-relaxed">{content}</p>
      ) : (
        <button
          onClick={generate}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-[#06d6a0]/40 text-[#06d6a0] text-sm py-2.5 hover:bg-[#06d6a0]/10 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
          {loading ? "Analyzing your match…" : "Why did I win/lose? Ask Ninja"}
        </button>
      )}
    </div>
  );
}
