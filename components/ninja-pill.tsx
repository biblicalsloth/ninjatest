"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, ChevronDown } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { createClient } from "@/lib/supabase/client";
import { NINJA_ASK_EVENT, type NinjaAskDetail } from "@/lib/ninja";

interface SavedResponse {
  id: string;
  model_id: string;
  content: string;
  created_at: string;
}

// Floating Ninja pill: collapsed by default, its window opens only when a
// question is asked (via the ninja:ask event). Auto-saves each answer server-side;
// history is scoped to the (match, question) it was asked for.
export function NinjaPill() {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<NinjaAskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedResponse[]>([]);
  const reqId = useRef(0);

  const loadHistory = useCallback(async (matchId: string, questionIndex: number) => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("get_ninja_responses", {
      p_match_id: matchId, p_index: questionIndex,
    });
    setHistory(Array.isArray(data) ? (data as SavedResponse[]) : []);
  }, []);

  const ask = useCallback(async (detail: NinjaAskDetail) => {
    const id = ++reqId.current;
    setCtx(detail);
    setOpen(true);
    setError(null);
    setLoading(true);
    setHistory([]);
    await loadHistory(detail.matchId, detail.questionIndex);
    try {
      const res = await fetch("/api/ninja/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_id: detail.matchId, question_index: detail.questionIndex }),
      });
      const json = await res.json().catch(() => ({}));
      if (id !== reqId.current) return; // superseded by a newer ask
      if (!res.ok) {
        setError(json.error ?? "Ninja could not answer");
      } else {
        await loadHistory(detail.matchId, detail.questionIndex);
      }
    } catch {
      if (id === reqId.current) setError("Network error");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [loadHistory]);

  useEffect(() => {
    const handler = (e: Event) => ask((e as CustomEvent<NinjaAskDetail>).detail);
    window.addEventListener(NINJA_ASK_EVENT, handler);
    return () => window.removeEventListener(NINJA_ASK_EVENT, handler);
  }, [ask]);

  // Collapsed: a floating badge only. It never opens the window — the window
  // appears solely when a question is sent to Ninja to solve (ninja:ask).
  if (!open) {
    return (
      <div
        aria-label="Ninja — tap a question to solve"
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[#06d6a0] pl-3 pr-4 py-2.5 text-[#073b4c] font-semibold shadow-lg shadow-[#06d6a0]/20 pointer-events-none select-none"
      >
        <NinjaLogo color="#073b4c" className="w-5 h-5" />
        <span className="text-sm">Ninja</span>
      </div>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(92vw,380px)] rounded-2xl border border-[#333333] bg-[#111111] shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#222222]">
        <div className="flex items-center gap-2">
          <NinjaLogo color="#06d6a0" className="w-5 h-5" />
          <span className="text-white text-sm font-semibold">Ninja</span>
          {ctx && <span className="text-[#7ab5cc] text-xs">· {ctx.label}</span>}
        </div>
        <button onClick={() => setOpen(false)} aria-label="Collapse" className="text-[#7ab5cc] hover:text-white">
          <ChevronDown size={18} />
        </button>
      </div>

      <div className="max-h-[50vh] overflow-y-auto px-4 py-3 space-y-3">
        {loading && (
          <p className="text-[#06d6a0] text-sm animate-pulse">Ninja is thinking…</p>
        )}
        {error && (
          <div className="flex items-start gap-2 text-[#ef476f] text-sm">
            <X size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {history.map((r, i) => (
          <div key={r.id} className="rounded-lg bg-[#120F17] p-3">
            {i > 0 && <p className="text-[#4a8fa8] text-[10px] mb-1">Earlier attempt</p>}
            <p className="text-[#c5e8f0] text-sm whitespace-pre-wrap leading-relaxed">{r.content}</p>
            <p className="text-[#4a8fa8] text-[10px] mt-2">{r.model_id}</p>
          </div>
        ))}
        {!loading && !error && ctx && history.length === 0 && (
          <p className="text-[#7ab5cc] text-sm">No answer yet.</p>
        )}
      </div>
    </div>
  );
}
