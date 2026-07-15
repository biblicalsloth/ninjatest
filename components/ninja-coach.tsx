"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Send, X } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { NINJA_COACH_EVENT } from "@/lib/ninja";

type CoachState = "closed" | "panel" | "expanded";

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

// Buddy (Socratic) starters — guide the user through their own weak spots.
const BUDDY_SUGGESTIONS = [
  "Walk me through my most recent mistake",
  "Quiz me on my weakest section",
  "Help me get faster at Quant",
];

// Floating Ninja Coach: freeform Q&A over the user's own stats. Server-side the
// model pulls their profile/sections/margins/opponents and answers grounded in
// real numbers. Collapsed to a badge until opened.
export function NinjaCoach() {
  const [state, setState] = useState<CoachState>("closed");
  const [mode, setMode] = useState<"coach" | "buddy">("coach");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Nav "Ask Ninja" button fires NINJA_COACH_EVENT: closed → panel, panel → expanded.
  useEffect(() => {
    const open = () => setState((s) => (s === "expanded" ? "expanded" : s === "panel" ? "expanded" : "panel"));
    window.addEventListener(NINJA_COACH_EVENT, open);
    return () => window.removeEventListener(NINJA_COACH_EVENT, open);
  }, []);

  // Escape returns expanded → panel; focus the input when opening either surface.
  useEffect(() => {
    if (state === "closed") return;
    inputRef.current?.focus();
    if (state !== "expanded") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setState("panel");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const ask = async (question: string, override?: "plan" | "socratic") => {
    const q = question.trim();
    if (!q || busy) return;
    // Buddy toggle → Socratic; plan pill passes its own override.
    const reqMode = override ?? (mode === "buddy" ? "socratic" : undefined);
    setInput("");
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { q, a: null }]);
    try {
      const res = await fetch("/api/ninja/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, ...(reqMode ? { mode: reqMode } : {}) }),
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

  if (state === "closed") {
    return (
      <button
        onClick={() => setState("panel")}
        aria-label="Ask Ninja about your stats"
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[#06d6a0] pl-3 pr-4 py-2.5 text-[#073b4c] font-semibold shadow-lg shadow-[#06d6a0]/20 hover:brightness-105 transition"
      >
        <NinjaLogo color="#073b4c" className="w-5 h-5" />
        <span className="text-sm">Ask Ninja</span>
      </button>
    );
  }

  const expanded = state === "expanded";

  const dialog = (
    <div
      className={
        expanded
          ? "w-[min(92vw,720px)] h-[min(80vh,640px)] rounded-2xl border border-[#333333] bg-[#111111] shadow-2xl overflow-hidden flex flex-col"
          : "fixed bottom-5 right-5 z-50 w-[min(92vw,400px)] rounded-2xl border border-[#333333] bg-[#111111] shadow-2xl overflow-hidden flex flex-col"
      }
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#222222]">
        <div className="flex items-center gap-2">
          <NinjaLogo color="#06d6a0" className="w-5 h-5" />
          <div className="flex rounded-full bg-[#120F17] p-0.5 text-xs font-semibold">
            {(["coach", "buddy"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-full px-2.5 py-1 capitalize transition ${
                  mode === m ? "bg-[#06d6a0] text-[#073b4c]" : "text-[#7ab5cc] hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setState(expanded ? "panel" : "expanded")}
            aria-label={expanded ? "Minimize" : "Expand"}
            className="text-[#7ab5cc] hover:text-white"
          >
            {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button onClick={() => setState("closed")} aria-label="Collapse" className="text-[#7ab5cc] hover:text-white">
            <ChevronDown size={18} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className={`overflow-y-auto px-4 py-3 space-y-4 ${expanded ? "flex-1" : "max-h-[55vh] min-h-[120px]"}`}>
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-[#7ab5cc] text-sm">
              {mode === "buddy"
                ? "I'll guide you step by step — pick something to work through."
                : "Ask about your stats, weak sections, or what to practice."}
            </p>
            <div className="flex flex-wrap gap-2">
              {mode === "coach" && (
                <button onClick={() => ask("Build my weekly study plan", "plan")}
                  className="rounded-full border border-[#06d6a0]/50 bg-[#06d6a0]/10 px-3 py-1 text-xs text-[#06d6a0] hover:bg-[#06d6a0]/20 transition font-semibold">
                  📅 Build my weekly plan
                </button>
              )}
              {(mode === "buddy" ? BUDDY_SUGGESTIONS : SUGGESTIONS).map((s) => (
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
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder={mode === "buddy" ? "Tell me what you're stuck on…" : "Ask Ninja…"}
          className="flex-1 bg-transparent text-sm text-white placeholder:text-[#4a8fa8] outline-none disabled:opacity-50"
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"
          className="text-[#06d6a0] disabled:text-[#333333] hover:brightness-110 transition">
          <Send size={18} />
        </button>
      </form>
    </div>
  );

  if (!expanded) return dialog;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => setState("panel")}
    >
      <div onClick={(e) => e.stopPropagation()}>{dialog}</div>
    </div>
  );
}
