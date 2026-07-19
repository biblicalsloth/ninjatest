"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, Send, Trash2, PanelLeft, Paperclip, X, Loader2 } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { NinjaNav } from "@/components/ninja-nav";
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

// Plan mode used to live here as a button in the composer. It's now /plan — its
// own route, cached per week, rendered as a calendar. Chat is chat. The
// Coach/Buddy toggle lives in the shared NinjaNav, not the rail.
type Mode = "coach" | "buddy";

const REQ_MODE: Record<Mode, string | undefined> = { coach: undefined, buddy: "socratic" };

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
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // PDF from the composer rides the existing solve pipeline (/ninja/solve →
  // /api/ninja/solve). ponytail: a File can't survive router serialization, so
  // it's handed over via a window slot the solve page picks up on mount.
  const onPdf = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    (window as unknown as { __ninjaSolveFile?: File }).__ninjaSolveFile = f;
    router.push("/ninja/solve");
  };

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

  // One composer, two homes: centered mid-screen on the empty state, pinned
  // bottom-center once a conversation exists. Paperclip feeds the solve pipeline.
  const composerForm = (
    <form
      onSubmit={(e) => { e.preventDefault(); send(input); }}
      className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-[#1c1a24] bg-[#111111] px-3 py-2 focus-within:border-[#06d6a0]/60 transition"
    >
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        aria-label="Upload a PDF for Ninja to solve"
        title="Upload a PDF — Ninja solves the whole paper"
        className="mb-0.5 rounded-lg p-1.5 text-[#7ab5cc] hover:text-[#06d6a0] transition"
      >
        <Paperclip size={16} />
      </button>
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
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={onPdf} />
    </form>
  );

  // Conversations rail — mode toggle and screen links moved to NinjaNav, so
  // this is purely the thread list with its new-chat + search affordances.
  const sidebar = (
    <div className="flex h-full w-72 shrink-0 flex-col border-r md:border-r-0 md:border-l border-[#1c1a24] bg-[#0d0d0d]">
      <div className="flex items-center justify-between px-4 pt-5 pb-3">
        <p className="font-pixel text-xs text-[#7ab5cc]">Chats</p>
        <button onClick={() => setDrawer(false)} className="md:hidden text-[#7ab5cc] hover:text-white transition" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <button
          onClick={newChat}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#06d6a0] px-3 py-2 text-[#073b4c] text-sm font-semibold hover:brightness-105 transition"
        >
          <Plus size={16} /> New chat
        </button>
        <div className="flex items-center gap-2 rounded-xl border border-[#1c1a24] bg-[#120F17] px-3 py-2 focus-within:border-[#06d6a0]/40 transition">
          <Search size={14} className="shrink-0 text-[#4a8fa8]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-sm text-white placeholder:text-[#4a8fa8] outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
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
                className={`group flex items-center gap-1 rounded-xl border pr-1 transition ${
                  on ? "border-[#06d6a0]/40 bg-[#111111]" : "border-transparent hover:bg-[#111111]/70"
                }`}
              >
                <button
                  onClick={() => openConversation(c.conversation_id)}
                  className="flex-1 min-w-0 text-left px-3 py-2"
                >
                  <p className={`truncate text-sm ${on ? "text-white" : "text-[#c5e8f0]"}`}>{c.title || "Untitled chat"}</p>
                  <p className="mt-0.5 text-[10px] text-[#4a8fa8]">{new Date(c.last_at).toLocaleDateString()} · {c.turns} turn{c.turns === 1 ? "" : "s"}</p>
                </button>
                <button
                  onClick={() => removeConversation(c.conversation_id)}
                  aria-label="Delete chat"
                  className="shrink-0 rounded-lg p-1.5 text-[#4a8fa8] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[#ef476f] transition"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 flex flex-col bg-[#120F17]">
      {/* Full-width nav: the logo sits in the lobby gutter exactly like the
          other Ninja screens; the item cluster's md:mr-72 (in NinjaNav)
          keeps the links clear of the rail below. */}
      <NinjaNav
        active="chat"
        mode={mode}
        onModeChange={setMode}
        right={
          <button onClick={() => setDrawer(true)} className="md:hidden text-[#7ab5cc]" aria-label="Open chats">
            <PanelLeft size={18} />
          </button>
        }
      />

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10 h-full" onClick={(e) => e.stopPropagation()}>{sidebar}</div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0 md:pl-20">
        {loadingThread ? (
          <div className="flex flex-1 items-center justify-center text-[#06d6a0]"><Loader2 className="animate-spin" size={22} /></div>
        ) : turns.length === 0 ? (
          /* Empty state — composer centered mid-screen, suggestion chips below.
             The hero reserves fixed heights (blurb = 2 lines) so toggling
             Coach/Buddy can't reflow the composer: zero movement by design. */
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-10">
            <div className="text-center">
              <NinjaLogo color="#06d6a0" className="mx-auto h-12 w-12" />
              <h2 className="mt-4 font-pixel text-white text-xl">{HERO_TITLE}</h2>
              <p className="mx-auto mt-1 max-w-md min-h-10 text-[#7ab5cc] text-sm">{HERO_BLURB[mode]}</p>
            </div>
            {composerForm}
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-[#333333] px-3.5 py-1.5 text-xs text-[#c5e8f0] hover:border-[#06d6a0] hover:text-[#06d6a0] transition"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Thread */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
            </div>

            {/* Composer pinned bottom-center once a conversation exists */}
            <div className="border-t border-[#1c1a24] px-4 py-3">
              {composerForm}
              <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-[#4a8fa8]">
                Ninja can be wrong — verify anything important. Enter to send, Shift+Enter for a new line.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Desktop sidebar (right) */}
      <div className="hidden md:flex">{sidebar}</div>
      </div>
    </div>
  );
}

const HERO_TITLE = "Ask Ninja anything";
const HERO_BLURB: Record<Mode, string> = {
  coach: "Grounded in your real stats — sections, margins, streaks, and recent mistakes.",
  buddy: "I'll guide you through your weak spots step by step.",
};

