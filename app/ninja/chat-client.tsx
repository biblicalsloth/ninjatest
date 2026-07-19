"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BarChart3, Check, ChevronDown, Lightbulb, Plus, Search, Trash2, PanelLeft, Paperclip, X, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import AILoadingState from "@/components/kokonutui/ai-loading";
import AITextLoading from "@/components/kokonutui/ai-text-loading";
import { NinjaLogo } from "@/components/ninja-logo";
import { NinjaNav } from "@/components/ninja-nav";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutoResizeTextarea } from "@/hooks/use-auto-resize-textarea";
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

// Composer mode selector (Kokonut AI-Prompt pattern) — same state the NinjaNav
// toggle drives, surfaced where you type.
const MODE_META: Record<Mode, { label: string; hint: string; icon: React.ReactNode }> = {
  coach: { label: "Coach", hint: "Grounded in your stats", icon: <BarChart3 size={14} className="text-[#06d6a0]" /> },
  buddy: { label: "Buddy", hint: "Hints, not answers", icon: <Lightbulb size={14} className="text-[#ffd166]" /> },
};

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
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({ minHeight: 48, maxHeight: 160 });
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
    textareaRef.current?.focus();
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

  const submit = () => {
    send(input);
    adjustHeight(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  // One composer, two homes: centered mid-screen on the empty state, pinned
  // bottom-center once a conversation exists. Kokonut AI-Prompt layout: textarea
  // on top, bottom bar with the animated mode selector + paperclip (solve
  // pipeline) on the left, send on the right.
  const composerForm = (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-[#1c1a24] bg-[#111111] p-1.5 focus-within:border-[#06d6a0]/60 transition"
    >
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => { setInput(e.target.value); adjustHeight(); }}
        onKeyDown={onKeyDown}
        placeholder={mode === "buddy" ? "Tell me what you're stuck on…" : "Ask Ninja about your stats, plan, or mistakes…"}
        className="min-h-[48px] w-full resize-none rounded-xl border-none bg-transparent px-3 py-3 text-sm text-white shadow-none placeholder:text-[#4a8fa8] focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <div className="flex items-center justify-between px-1.5 pb-1 pt-1.5">
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-[#c5e8f0] hover:bg-white/5 transition outline-none focus-visible:ring-1 focus-visible:ring-[#06d6a0]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={mode}
                  className="flex items-center gap-1.5"
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 5 }}
                  transition={{ duration: 0.15 }}
                >
                  {MODE_META[mode].icon}
                  {MODE_META[mode].label}
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </motion.div>
              </AnimatePresence>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[13rem] border border-[#1c1a24] bg-[#111111] ring-0">
              {(Object.keys(MODE_META) as Mode[]).map((m) => (
                <DropdownMenuItem
                  key={m}
                  onClick={() => setMode(m)}
                  className="flex items-center justify-between gap-2 text-[#c5e8f0] focus:bg-white/5 focus:text-white"
                >
                  <div className="flex items-center gap-2">
                    {MODE_META[m].icon}
                    <span className="text-sm">{MODE_META[m].label}</span>
                    <span className="text-[10px] text-[#4a8fa8]">{MODE_META[m].hint}</span>
                  </div>
                  {mode === m && <Check className="h-4 w-4 text-[#06d6a0]" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mx-0.5 h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Upload a PDF for Ninja to solve"
            title="Upload a PDF — Ninja solves the whole paper"
            className="rounded-lg p-2 text-[#7ab5cc] hover:bg-white/5 hover:text-[#06d6a0] transition"
          >
            <Paperclip size={16} />
          </button>
        </div>
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="rounded-lg bg-[#06d6a0] p-2 text-[#073b4c] disabled:opacity-30 hover:brightness-105 transition"
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
        </button>
      </div>
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
          <div className="flex flex-1 items-center justify-center">
            <AITextLoading texts={["Opening chat…", "Loading turns…", "Almost there…"]} className="font-pixel text-xl" />
          </div>
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
                        {t.a === null && !t.error && <AILoadingState />}
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

