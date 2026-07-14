"use client";

import { useRef, useState } from "react";
import { ChevronDown, Send, X } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";

interface Turn {
  q: string;
  a: string | null;   // null while pending
  error?: string;
}

const SUGGESTIONS = [
  "What's my weakest section?",
  "Am I improving or plateauing?",
  "What should I practice next?",
];

// Floating Ninja Coach: freeform Q&A over the user's own stats. Server-side the
// model pulls their profile/sections/margins/opponents and answers grounded in
// real numbers. Collapsed to a badge until opened.
export function NinjaCoach() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = async (question: string, mode?: "plan") => {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { q, a: null }]);
    try {
      const res = await fetch("/api/ninja/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, ...(mode ? { mode } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      setTurns((t) => t.map((turn, i) =>
        i === idx
          ? res.ok ? { ...turn, a: json.content ?? "" } : { ...turn, a: null, error: json.error ?? "Ninja could not answer" }
          : turn,
      ));
    } catch {
      setTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, a: null, error: "Network error" } : turn)));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Ask Ninja about your stats"
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[#06d6a0] pl-3 pr-4 py-2.5 text-[#073b4c] font-semibold shadow-lg shadow-[#06d6a0]/20 hover:brightness-105 transition"
      >
        <NinjaLogo color="#073b4c" className="w-5 h-5" />
        <span className="text-sm">Ask Ninja</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(92vw,400px)] rounded-2xl border border-[#333333] bg-[#111111] shadow-2xl overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#222222]">
        <div className="flex items-center gap-2">
          <NinjaLogo color="#06d6a0" className="w-5 h-5" />
          <span className="text-white text-sm font-semibold">Ninja Coach</span>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Collapse" className="text-[#7ab5cc] hover:text-white">
          <ChevronDown size={18} />
        </button>
      </div>

      <div ref={scrollRef} className="max-h-[55vh] min-h-[120px] overflow-y-auto px-4 py-3 space-y-4">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-[#7ab5cc] text-sm">Ask about your stats, weak sections, or what to practice.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => ask("Build my weekly study plan", "plan")}
                className="rounded-full border border-[#06d6a0]/50 bg-[#06d6a0]/10 px-3 py-1 text-xs text-[#06d6a0] hover:bg-[#06d6a0]/20 transition font-semibold">
                📅 Build my weekly plan
              </button>
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)}
                  className="rounded-full border border-[#333333] px-3 py-1 text-xs text-[#c5e8f0] hover:border-[#06d6a0] hover:text-[#06d6a0] transition">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <p className="text-white text-sm font-medium text-right">{t.q}</p>
            {t.a === null && !t.error && <p className="text-[#06d6a0] text-sm animate-pulse">Ninja is analyzing your stats…</p>}
            {t.error && (
              <div className="flex items-start gap-2 text-[#ef476f] text-sm">
                <X size={14} className="mt-0.5 shrink-0" /> <span>{t.error}</span>
              </div>
            )}
            {t.a && (
              <div className="rounded-lg bg-[#120F17] p-3">
                <p className="text-[#c5e8f0] text-sm whitespace-pre-wrap leading-relaxed">{t.a}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); ask(input); }}
        className="flex items-center gap-2 border-t border-[#222222] px-3 py-2.5"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder="Ask Ninja…"
          className="flex-1 bg-transparent text-sm text-white placeholder:text-[#4a8fa8] outline-none disabled:opacity-50"
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"
          className="text-[#06d6a0] disabled:text-[#333333] hover:brightness-110 transition">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
