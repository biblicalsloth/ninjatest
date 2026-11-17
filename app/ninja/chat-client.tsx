"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, BarChart3, Check, ChevronDown, Lightbulb, Plus, Search, Trash2, PanelLeft, Paperclip, X, Loader2,
  MessageSquarePlus, MonitorUp, TrendingUp, Layers, AlertTriangle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import AILoadingState from "@/components/kokonutui/ai-loading";
import AITextLoading from "@/components/kokonutui/ai-text-loading";
import { NinjaLogo } from "@/components/ninja-logo";
import { NinjaMascot } from "@/components/ninja-mascot";
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
  img?: string; // screen snapshot sent with this turn (this session only — not persisted)
  error?: string;
}

const SUGGESTIONS = [
  { tag: "Stats", q: "What's my weakest section?", icon: <BarChart3 size={16} className="text-[#06d6a0]" /> },
  { tag: "Progress", q: "Am I improving or plateauing?", icon: <TrendingUp size={16} className="text-[#ffd166]" /> },
  { tag: "Sections", q: "Which section is costing me the most points?", icon: <Layers size={16} className="text-[#7ab5cc]" /> },
  { tag: "Mistakes", q: "Walk me through my most recent mistake", icon: <AlertTriangle size={16} className="text-[#ef476f]" /> },
];

const SCREEN_DEFAULT_Q = "Here's my screen — help me with what's on it.";
const SHOT_MAX_PX = 1280;
const SHOT_MAX_LEN = 1_500_000; // mirrors isValidSnapshot in lib/ai/model.ts

// Plan lives at /plan (its own route, cached per week). Chat is chat.
type Mode = "coach" | "buddy";

const REQ_MODE: Record<Mode, string | undefined> = { coach: undefined, buddy: "socratic" };

// Composer mode selector (Kokonut AI-Prompt pattern).
const MODE_META: Record<Mode, { label: string; hint: string; icon: React.ReactNode }> = {
  coach: { label: "Coach", hint: "Grounded in your stats", icon: <BarChart3 size={14} className="text-[#06d6a0]" /> },
  buddy: { label: "Buddy", hint: "Hints, not answers", icon: <Lightbulb size={14} className="text-[#ffd166]" /> },
};

// /ninja — Ask Ninja (Ninja Hanzo). Left rail = saved conversations
// (searchable, collapsible); main = hero (empty) or the active thread, with the
// composer pinned bottom in both states. Each chat is a conversation_id
// (minted client-side); the coach route persists every turn under it.
// "Share your screen" grabs ONE frame via getDisplayMedia and sends it with the
// next question; the route sends it to ai_config.vision_model_id.
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
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [railOpen, setRailOpen] = useState(true); // desktop rail
  const [drawer, setDrawer] = useState(false); // mobile rail
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

  const captureScreen = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast.error("Screen sharing isn't supported in this browser.");
      return;
    }
    let stream: MediaStream | null = null;
    setCapturing(true);
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const scale = Math.min(1, SHOT_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      let url = canvas.toDataURL("image/jpeg", 0.8);
      if (url.length > SHOT_MAX_LEN) url = canvas.toDataURL("image/jpeg", 0.5);
      if (url.length > SHOT_MAX_LEN) throw new Error("too big");
      setShot(url);
      textareaRef.current?.focus();
    } catch (e) {
      // NotAllowedError = user closed the picker; nothing to say.
      if ((e as Error)?.name !== "NotAllowedError") toast.error("Couldn't capture your screen.");
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setCapturing(false);
    }
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
    const img = shot ?? undefined;
    const q = raw.trim() || (img ? SCREEN_DEFAULT_Q : "");
    if (!q || busy) return;
    // First message of a brand-new chat mints the conversation id.
    const convId = activeId ?? crypto.randomUUID();
    if (activeId === null) setActiveId(convId);
    const reqMode = REQ_MODE[mode];
    setInput("");
    setShot(null);
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { q, a: null, img }]);
    scrollToEnd();
    try {
      const res = await fetch("/api/ninja/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          conversation_id: convId,
          ...(reqMode ? { mode: reqMode } : {}),
          ...(img ? { image: img } : {}),
        }),
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

  const placeholder = shot
    ? "What should Ninja look at?"
    : mode === "buddy" ? "Tell me what you're stuck on…" : "Ask Ninja about your stats, plan, or mistakes…";

  const composer = (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-[#1c1a24] bg-[#111111] p-1.5 focus-within:border-[#06d6a0]/60 transition"
    >
      {shot && (
        <div className="px-2 pt-2">
          <div className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL, next/image adds nothing */}
            <img src={shot} alt="Screen snapshot" className="h-16 rounded-lg border border-[#1c1a24] object-cover" />
            <button
              type="button"
              onClick={() => setShot(null)}
              aria-label="Remove screenshot"
              className="absolute -right-2 -top-2 rounded-full bg-[#1c1a24] p-1 text-[#c5e8f0] hover:text-[#ef476f] transition"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => { setInput(e.target.value); adjustHeight(); }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="min-h-[48px] w-full resize-none rounded-xl border-none bg-transparent px-3 py-3 text-sm text-white shadow-none placeholder:text-[#4a8fa8] focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <div className="flex items-center justify-between gap-2 border-t border-[#1c1a24] px-1.5 pb-1 pt-1.5">
        <div className="flex items-center gap-1">
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
            title="Upload a PDF — Ninja solves the whole paper"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-[#7ab5cc] hover:bg-white/5 hover:text-[#06d6a0] transition"
          >
            <Paperclip size={14} /> <span className="hidden sm:inline">PDF</span>
          </button>
          <button
            type="button"
            onClick={captureScreen}
            disabled={capturing}
            title="Share your screen — Ninja sees one snapshot"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-[#7ab5cc] hover:bg-white/5 hover:text-[#06d6a0] disabled:opacity-50 transition"
          >
            <MonitorUp size={14} /> <span className="hidden sm:inline">Screen</span>
          </button>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden lg:inline text-[10px] text-[#4a8fa8]">Enter to send · Shift+Enter for new line</span>
          <button
            type="submit"
            disabled={busy || (!input.trim() && !shot)}
            aria-label="Send"
            className="rounded-lg bg-[#06d6a0] p-2 text-[#073b4c] disabled:opacity-30 hover:brightness-105 transition"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={onPdf} />
    </form>
  );

  const rail = (onClose: () => void, closeIcon: React.ReactNode) => (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-[#1c1a24] bg-[#0d0d0d]">
      <div className="flex items-center gap-2 px-3 pt-4 pb-3">
        <button
          onClick={onClose}
          aria-label="Close chats"
          className="rounded-lg p-2 text-[#7ab5cc] hover:bg-white/5 hover:text-white transition"
        >
          {closeIcon}
        </button>
        <button
          onClick={newChat}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#06d6a0] px-3 py-2 text-[#073b4c] text-sm font-semibold hover:brightness-105 transition"
        >
          <Plus size={16} /> New chat
        </button>
      </div>
      <div className="px-3 pb-3">
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
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <MessageSquarePlus size={22} className="text-[#4a8fa8]" />
            <p className="text-xs text-[#4a8fa8]">{query ? "No matches." : "Your chats with Ninja Hanzo will show up here."}</p>
          </div>
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
    // Fills the viewport beside the SideNav: --nav-w / --nav-h come from
    // globals.css (set when the sidebar / mobile top bar exists).
    <div className="fixed inset-x-0 bottom-0 top-[var(--nav-h,0px)] md:top-0 md:left-[var(--nav-w,0px)] flex bg-[#120F17] nav-ease transition-[left]">
      {/* Desktop rail (left, collapsible) */}
      {railOpen && <div className="hidden md:flex">{rail(() => setRailOpen(false), <PanelLeft size={18} />)}</div>}

      {/* Mobile rail drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 flex md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10 h-full" onClick={(e) => e.stopPropagation()}>{rail(() => setDrawer(false), <X size={18} />)}</div>
        </div>
      )}

      <div className="flex flex-1 flex-col min-w-0">
        {/* Rail toggle when it's hidden (always on mobile) */}
        <div className={`flex items-center gap-2 px-3 pt-3 ${railOpen ? "md:hidden" : ""}`}>
          <button
            onClick={() => (window.matchMedia("(min-width: 768px)").matches ? setRailOpen(true) : setDrawer(true))}
            aria-label="Open chats"
            className="rounded-lg p-2 text-[#7ab5cc] hover:bg-white/5 hover:text-white transition"
          >
            <PanelLeft size={18} />
          </button>
          <button
            onClick={newChat}
            aria-label="New chat"
            className="rounded-lg p-2 text-[#7ab5cc] hover:bg-white/5 hover:text-white transition"
          >
            <Plus size={18} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {loadingThread ? (
            <div className="flex h-full items-center justify-center">
              <AITextLoading texts={["Opening chat…", "Loading turns…", "Almost there…"]} className="font-pixel text-xl" />
            </div>
          ) : turns.length === 0 ? (
            <Hero onStart={newChat} onShare={captureScreen} capturing={capturing} onAsk={send} />
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
              {turns.map((t, i) => (
                <div key={i} className="space-y-3">
                  <div className="flex flex-col items-end gap-2">
                    {t.img && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.img} alt="Shared screen" className="max-h-40 rounded-xl border border-[#1c1a24]" />
                    )}
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
          )}
        </div>

        {/* Composer — pinned bottom in every state */}
        <div className="px-4 pb-3 pt-2">
          {composer}
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-[#4a8fa8]">
            Ninja can make mistakes — verify anything important.
          </p>
        </div>
      </div>
    </div>
  );
}

function Hero({
  onStart,
  onShare,
  capturing,
  onAsk,
}: {
  onStart: () => void;
  onShare: () => void;
  capturing: boolean;
  onAsk: (q: string) => void;
}) {
  return (
    // Phone layout is compact on purpose: the composer is pinned below, so the
    // whole hero (incl. all four suggestions) has to fit above it at ~390x844.
    <div className="mx-auto flex max-w-3xl flex-col items-center px-4 pt-4 pb-4 sm:pt-10 sm:pb-6">
      <NinjaMascot size={112} className="h-[72px] w-[72px] sm:h-28 sm:w-28" />
      <h1 className="mt-3 text-center font-pixel text-xl text-white sm:mt-5 sm:text-3xl">
        Hi! I&apos;m <span className="text-[#06d6a0]">Ninja Hanzo</span>
      </h1>
      <p className="mt-1.5 max-w-md text-center text-xs text-[#7ab5cc] sm:mt-2 sm:text-sm">
        Ask about your stats, get unstuck on a question, or show me your screen.
      </p>

      <div className="mt-5 grid w-full grid-cols-2 gap-2 sm:mt-8 sm:gap-3">
        <ActionCard
          onClick={onStart}
          icon={<MessageSquarePlus size={20} />}
          title="Start a chat"
          sub="Ask anything about your prep."
        />
        <ActionCard
          onClick={onShare}
          disabled={capturing}
          icon={capturing ? <Loader2 size={20} className="animate-spin" /> : <MonitorUp size={20} />}
          title="Share your screen"
          sub="Show me a question, get help with it."
        />
      </div>

      <div className="mt-6 flex w-full items-center gap-3 sm:mt-10">
        <div className="h-px flex-1 bg-[#1c1a24]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4a8fa8]">Or try asking me…</span>
        <div className="h-px flex-1 bg-[#1c1a24]" />
      </div>

      <div className="mt-3 grid w-full grid-cols-2 gap-2 sm:mt-4 sm:gap-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.q}
            onClick={() => onAsk(s.q)}
            className="flex items-start gap-3 rounded-2xl border border-[#1c1a24] bg-[#111111] p-3 text-left transition hover:border-[#06d6a0]/50 sm:items-center sm:p-4"
          >
            <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 sm:flex">{s.icon}</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#4a8fa8]">{s.tag}</span>
              <span className="block text-xs text-[#c5e8f0] sm:text-sm">{s.q}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  onClick,
  disabled,
  icon,
  title,
  sub,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-start gap-2 rounded-2xl bg-gradient-to-br from-[#0be4ad] to-[#06b98a] p-3 text-left sm:flex-row sm:items-center sm:gap-4 sm:p-4 shadow-[0_18px_40px_-18px_rgba(6,214,160,0.6)] transition hover:brightness-105 hover:-translate-y-0.5 disabled:opacity-70"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#073b4c]/15 text-[#073b4c] sm:h-11 sm:w-11">{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-[#073b4c] sm:text-base">{title}</span>
        <span className="hidden text-xs text-[#073b4c]/75 sm:block">{sub}</span>
      </span>
    </button>
  );
}
