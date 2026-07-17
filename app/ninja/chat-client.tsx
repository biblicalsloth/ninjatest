"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Search, Send, Trash2, PanelLeft, X, Loader2, CalendarDays } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { createClient } from "@/lib/supabase/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any; // conversation RPCs aren't in generated types yet.

interface Conversation {
  conversation_id: string;
  title: string;
  last_at: string;
  turns: number;
}
interface Turn {
  q: string;
  a: string | null; // null while pending
  error?: string;
}

const SUGGESTIONS = [
  "What's my weakest section?",
  "Am I improving or plateauing?",
  "Which section is costing me the most points?",
  "Walk me through my most recent mistake",
];

type Mode = "coach" | "buddy" | "plan";

const MODE_LABEL: Record<Mode, string> = { coach: "coach", buddy: "buddy", plan: "plan" };
const MODE_HINT: Record<Mode, string> = {
  coach: "Grounded in your real stats",
  buddy: "Socratic — I guide, you solve",
  plan: "A 7-day plan from your own numbers",
};
// Plan mode is one-shot: the server ignores any typed question and overrides it
// to this exact string (and skips thread history — it would fight the plan's
// output contract). The client sends the same text so the saved turn and the
// rendered bubble agree after a reload.
const PLAN_QUESTION = "Build my weekly study plan.";
const REQ_MODE: Record<Mode, string | undefined> = { coach: undefined, buddy: "socratic", plan: "plan" };

// /ninja — modern-LLM chat over the user's own stats (the dock's Ninja AI entry
// point; the read-only archive lives at /ninja/history). Left rail = saved
// conversations (searchable); main = the active thread + a chatbox. Each chat is
// a conversation_id (minted client-side); the coach route persists every turn
// under it, so history survives reloads and devices.
export default function ChatClient() {
  const supabase = createClient() as AnyClient;
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("coach");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false); // mobile sidebar
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const refreshList = useCallback(async () => {
    const { data } = await supabase.rpc("list_coach_conversations");
    setConversations(Array.isArray(data) ? (data as Conversation[]) : []);
  }, [supabase]);

  useEffect(() => {
    let active = true;
    supabase.rpc("list_coach_conversations").then(({ data }: { data: unknown }) => {
      if (active) setConversations(Array.isArray(data) ? (data as Conversation[]) : []);
    });
    return () => { active = false; };
  }, [supabase]);

  const scrollToEnd = () =>
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));

  const newChat = () => {
    setActiveId(null);
    setTurns([]);
    setDrawer(false);
    taRef.current?.focus();
  };

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setDrawer(false);
    setTurns([]);
    setLoadingThread(true);
    const { data } = await supabase.rpc("get_coach_conversation", { p_conversation_id: id });
    const rows = (Array.isArray(data) ? data : []) as { question: string; answer: string }[];
    setTurns(rows.map((r) => ({ q: r.question, a: r.answer })));
    setLoadingThread(false);
    scrollToEnd();
  }, [supabase]);

  const removeConversation = async (id: string) => {
    await supabase.rpc("delete_coach_conversation", { p_conversation_id: id });
    setConversations((c) => (c ? c.filter((x) => x.conversation_id !== id) : c));
    if (id === activeId) newChat();
  };

  const send = async (raw: string) => {
    const q = raw.trim();
    if (!q || busy) return;
    // First message of a brand-new chat mints the conversation id.
    const convId = activeId ?? crypto.randomUUID();
    const isNew = activeId === null;
    if (isNew) setActiveId(convId);
    const reqMode = REQ_MODE[mode];
    setInput("");
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { q, a: null }]);
    scrollToEnd();
    try {
      const res = await fetch("/api/ninja/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, conversation_id: convId, ...(reqMode ? { mode: reqMode } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      setTurns((t) => t.map((turn, i) =>
        i === idx
          ? res.ok ? { ...turn, a: json.content ?? "" } : { ...turn, a: null, error: json.error ?? "Ninja could not answer" }
          : turn,
      ));
      if (res.ok) refreshList(); // surface the new/updated conversation in the rail
    } catch {
      setTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, a: null, error: "Network error" } : turn)));
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  };

  const filtered = useMemo(() => {
    if (!conversations) return [];
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title?.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const sidebar = (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-[#222222] bg-[#0d0d0d]">
      <div className="flex items-center gap-2 px-3 py-3">
        <NinjaLogo color="#06d6a0" className="w-5 h-5" />
        <span className="text-white text-sm font-semibold">Ninja</span>
        <button onClick={() => setDrawer(false)} className="ml-auto md:hidden text-[#7ab5cc]" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="px-3">
        <button
          onClick={newChat}
          className="flex w-full items-center gap-2 rounded-lg bg-[#06d6a0] px-3 py-2 text-[#073b4c] text-sm font-semibold hover:brightness-105 transition"
        >
          <Plus size={16} /> New chat
        </button>
      </div>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 rounded-lg border border-[#222222] bg-[#120F17] px-2.5 py-1.5">
          <Search size={14} className="text-[#4a8fa8]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-sm text-white placeholder:text-[#4a8fa8] outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {conversations === null ? (
          <div className="flex justify-center py-6 text-[#06d6a0]"><Loader2 className="animate-spin" size={18} /></div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-4 text-[#4a8fa8] text-xs">{query ? "No matches." : "No saved chats yet."}</p>
        ) : (
          filtered.map((c) => {
            const on = c.conversation_id === activeId;
            return (
              <div
                key={c.conversation_id}
                className={`group flex items-center gap-1 rounded-lg pr-1 ${on ? "bg-[#111111]" : "hover:bg-[#111111]/60"}`}
              >
                <button
                  onClick={() => openConversation(c.conversation_id)}
                  className="flex-1 min-w-0 text-left px-2.5 py-2"
                >
                  <p className="truncate text-sm text-white">{c.title || "Untitled chat"}</p>
                  <p className="text-[10px] text-[#4a8fa8]">{new Date(c.last_at).toLocaleDateString()} · {c.turns} turn{c.turns === 1 ? "" : "s"}</p>
                </button>
                <button
                  onClick={() => removeConversation(c.conversation_id)}
                  aria-label="Delete chat"
                  className="shrink-0 p-1.5 text-[#4a8fa8] opacity-0 group-hover:opacity-100 hover:text-[#ef476f] transition"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-[#222222] px-3 py-2 flex gap-3 text-xs">
        <Link href="/ninja/history" className="text-[#7ab5cc] hover:text-[#06d6a0]">History</Link>
        <Link href="/ninja/solve" className="text-[#7ab5cc] hover:text-[#06d6a0]">Solve a paper</Link>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 flex bg-[#120F17] md:pl-20">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">{sidebar}</div>
      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10 h-full" onClick={(e) => e.stopPropagation()}>{sidebar}</div>
        </div>
      )}

      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex items-center gap-2 border-b border-[#222222] px-4 py-3">
          <button onClick={() => setDrawer(true)} className="md:hidden text-[#7ab5cc]" aria-label="Open chats">
            <PanelLeft size={18} />
          </button>
          <div className="flex rounded-full bg-[#111111] p-0.5 text-xs font-semibold">
            {(["coach", "buddy", "plan"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-full px-3 py-1 capitalize transition ${
                  mode === m ? "bg-[#06d6a0] text-[#073b4c]" : "text-[#7ab5cc] hover:text-white"
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] text-[#4a8fa8]">{MODE_HINT[mode]}</span>
        </div>

        {/* Thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {loadingThread ? (
            <div className="flex h-full items-center justify-center text-[#06d6a0]"><Loader2 className="animate-spin" size={22} /></div>
          ) : turns.length === 0 ? (
            <Hero mode={mode} onPick={send} />
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
              {turns.map((t, i) => (
                <div key={i} className="space-y-3">
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#06d6a0] px-4 py-2.5 text-[#073b4c] text-sm font-medium whitespace-pre-wrap">
                      {t.q}
                    </div>
                  </div>
                  <div className="flex gap-2.5">
                    <NinjaLogo color="#06d6a0" className="mt-1 h-5 w-5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      {t.a === null && !t.error && (
                        <p className="text-[#06d6a0] text-sm animate-pulse">Ninja is analyzing your stats…</p>
                      )}
                      {t.error && (
                        <div className="flex items-start gap-2 text-[#ef476f] text-sm">
                          <X size={14} className="mt-0.5 shrink-0" /> <span>{t.error}</span>
                        </div>
                      )}
                      {t.a && (
                        <p className="text-[#c5e8f0] text-sm whitespace-pre-wrap leading-relaxed">{t.a}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Composer — plan mode takes no input (the server fixes the prompt),
            so it gets a single button instead of a textarea that goes nowhere. */}
        <div className="border-t border-[#222222] px-4 py-3">
          {mode === "plan" ? (
            <button
              onClick={() => send(PLAN_QUESTION)}
              disabled={busy}
              className="mx-auto flex h-11 w-full max-w-3xl items-center justify-center gap-2 rounded-2xl bg-[#06d6a0] text-sm font-semibold text-[#073b4c] disabled:opacity-40 hover:brightness-105 transition"
            >
              {busy ? <Loader2 className="animate-spin" size={16} /> : <CalendarDays size={16} />}
              {busy ? "Building your plan…" : "Build my 7-day plan"}
            </button>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); send(input); }}
              className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-[#333333] bg-[#111111] px-3 py-2 focus-within:border-[#06d6a0]/60 transition"
            >
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={mode === "buddy" ? "Tell me what you're stuck on…" : "Ask Ninja about your stats, plan, or mistakes…"}
                className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm text-white placeholder:text-[#4a8fa8] outline-none"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="mb-0.5 rounded-lg bg-[#06d6a0] p-1.5 text-[#073b4c] disabled:opacity-30 hover:brightness-105 transition"
              >
                {busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
              </button>
            </form>
          )}
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-[#4a8fa8]">
            {mode === "plan"
              ? "Ninja can be wrong — verify anything important. Your plan is built from your real stats."
              : "Ninja can be wrong — verify anything important. Enter to send, Shift+Enter for a new line."}
          </p>
        </div>
      </div>
    </div>
  );
}

const HERO_TITLE: Record<Mode, string> = {
  coach: "Ask Ninja anything",
  buddy: "Ask Ninja anything",
  plan: "Your 7-day study plan",
};
const HERO_BLURB: Record<Mode, string> = {
  coach: "Grounded in your real stats — sections, margins, streaks, and recent mistakes.",
  buddy: "I'll guide you through your weak spots step by step.",
  plan: "One task a day, built from your ELO trend and your weakest section. Hit the button below.",
};

function Hero({ mode, onPick }: { mode: Mode; onPick: (q: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <NinjaLogo color="#06d6a0" className="h-12 w-12" />
      <div>
        <h1 className="text-white text-xl font-semibold">{HERO_TITLE[mode]}</h1>
        <p className="mt-1 text-[#7ab5cc] text-sm max-w-md">{HERO_BLURB[mode]}</p>
      </div>
      {/* Plan mode ignores any typed question, so suggestion chips would lie. */}
      {mode !== "plan" && (
        <div className="flex max-w-lg flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="rounded-full border border-[#333333] px-3.5 py-1.5 text-xs text-[#c5e8f0] hover:border-[#06d6a0] hover:text-[#06d6a0] transition"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
