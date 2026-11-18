"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, Crown as CrownIcon, Loader2, Users, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CountdownRing } from "@/components/countdown-ring";
import { QuestionBody } from "@/components/question-body";
import { QuestionDiagram } from "@/components/question-diagram";
import { C, Crown, Shuriken } from "@/components/lobby-shapes";
import type { CatSection } from "@/lib/supabase/types";
import { cn, getSectionBadgeClass, TITA_INPUT } from "@/lib/utils";

// /arena owns the whole loop: queue → ready-check → self-paced play → results.
// Everything is polled (arena_heartbeat before the game, get_arena_state
// during it) — the server is the clock and the referee; this file only renders.
// ponytail: 3s polling, move to postgres_changes on `arenas` if traffic grows.

const POLL_MS = 2500;
const REVEAL_MS = 1600;

interface Seat {
  username: string; display_name: string | null; avatar_url: string | null;
  me: boolean; elo?: number; accepted?: boolean;
  answered?: number; score?: number | null; correct?: number | null;
  rank?: number | null; elo_before?: number | null; elo_after?: number | null;
}
type Beat =
  | { phase: "idle" }
  | { phase: "waiting"; enqueued_at: string; server_now: string; searching: number }
  | { phase: "ready"; arena_id: string; deadline: string; server_now: string; me_accepted: boolean; players: Seat[] }
  | { phase: "active"; arena_id: string };
interface ArenaState { status: string; players: Seat[] }
interface Question {
  question_id: string; section: CatSection; body: string; options: string[];
  qtype: string; cap_ms: number; started_at: string;
  passage: string | null; image_url: string | null; passage_image_url: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = any;

export default function ArenaClient() {
  const router = useRouter();
  const sb: SB = useMemo(() => createClient(), []);
  const [beat, setBeat] = useState<Beat | null>(null);
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [cancelledNotice, setCancelledNotice] = useState(false);
  const [offset, setOffset] = useState(0); // server − client ms
  const [now, setNow] = useState(() => Date.now());
  const wasReady = useRef(false);
  const leftRef = useRef(false);

  // clock + server offset (request midpoint, same as match-client)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    const t0 = Date.now();
    sb.rpc("get_server_time").then(({ data }: { data: string | null }) => {
      if (data) setOffset(new Date(data).getTime() - (t0 + Date.now()) / 2);
    }, () => {});
    return () => clearInterval(id);
  }, [sb]);

  // join once, then heartbeat until the game starts
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      const { data, error } = await sb.rpc("arena_heartbeat");
      if (!alive) return;
      if (error) { toast.error(error.message); router.push("/lobby"); return; }
      const b = data as Beat;
      if (b.phase === "active") { setArenaId(b.arena_id); return; }
      if (b.phase === "ready") wasReady.current = true;
      if (b.phase === "idle" && wasReady.current) setCancelledNotice(true);
      if (b.phase === "waiting" && wasReady.current) {
        // back in the queue after someone else missed the ready-check
        wasReady.current = false;
        toast("Someone missed the ready-check — you're back in the queue, priority kept.");
      }
      setBeat(b);
      if (b.phase !== "idle") timer = setTimeout(tick, POLL_MS);
    }
    sb.rpc("arena_join").then(({ error }: { error: { message: string } | null }) => {
      if (!alive) return;
      if (error) {
        toast.error(error.message.replace(/^arena cooldown: /, ""));
        router.push("/lobby");
        return;
      }
      tick();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sb, router]);

  // leaving the page while still WAITING drops the queue row (never a ready-check)
  useEffect(() => () => {
    if (!leftRef.current) sb.rpc("arena_leave").then(() => {}, () => {});
  }, [sb]);

  async function leave() {
    leftRef.current = true;
    const { data } = await sb.rpc("arena_leave");
    if (data === false) { leftRef.current = false; toast("Lobby already found — accept or decline."); return; }
    router.push("/lobby");
  }

  const serverNow = now + offset;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-[#120F17] text-white">
        {arenaId ? (
          <ArenaGame sb={sb} arenaId={arenaId} serverNow={serverNow} />
        ) : cancelledNotice ? (
          <Center>
            <p className="font-pixel text-2xl">Ready-check missed</p>
            <p className="mt-2 max-w-sm text-center text-sm text-white/55">
              The lobby didn&apos;t fill in time. Missing a ready-check puts Arena on a short cooldown.
            </p>
            <Link href="/lobby" className="mt-6 rounded-full bg-[#06d6a0] px-5 py-2.5 text-sm font-semibold text-[#17131C]">Back to lobby</Link>
          </Center>
        ) : (
          <Searching beat={beat} serverNow={serverNow} onLeave={leave} />
        )}

        <AnimatePresence>
          {beat?.phase === "ready" && !arenaId && (
            <ReadyCheck key={beat.arena_id} sb={sb} beat={beat} serverNow={serverNow} />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center px-4">{children}</div>;
}

/* ─────────────────────────── Queue ─────────────────────────── */

function Searching({ beat, serverNow, onLeave }: { beat: Beat | null; serverNow: number; onLeave: () => void }) {
  const waited = beat?.phase === "waiting" ? Math.max(0, Math.floor((serverNow - new Date(beat.enqueued_at).getTime()) / 1000)) : 0;
  const searching = beat?.phase === "waiting" ? beat.searching : 1;
  const band = Math.min(1000, 100 + waited * 20);
  return (
    <Center>
      <div className="relative flex h-44 w-44 items-center justify-center">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full border border-[#F5D96B]/40"
            animate={{ scale: [0.6, 1.5], opacity: [0.6, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }}
          />
        ))}
        <div className="relative isolate flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[#F5D96B] text-[#17131C]">
          <Crown color={C.butterTone} className="-right-4 -top-3 -z-10 h-16 w-16" />
          <Users size={30} />
        </div>
      </div>
      <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#F5D96B]">Arena</p>
      <h1 className="mt-1 font-pixel text-3xl">Finding your lobby</h1>
      <p className="mt-2 text-sm text-white/55">
        {searching} searching · pops at 8, or 4+ after a minute
      </p>
      <div className="mt-6 grid grid-cols-3 gap-6 text-center">
        <Stat label="Waited" value={`${Math.floor(waited / 60)}:${String(waited % 60).padStart(2, "0")}`} />
        <Stat label="Your band" value={band >= 1000 ? "any" : `±${band}`} />
        <Stat label="Seats" value="4–8" />
      </div>
      <button onClick={onLeave} className="mt-8 flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm text-white/70 ring-1 ring-white/15 transition hover:bg-white/5 hover:text-white">
        <X size={14} /> Leave queue
      </button>
    </Center>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-bold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/45">{label}</div>
    </div>
  );
}

/* ─────────────────────────── Ready-check ─────────────────────────── */

function ReadyCheck({ sb, beat, serverNow }: { sb: SB; beat: Extract<Beat, { phase: "ready" }>; serverNow: number }) {
  const [busy, setBusy] = useState(false);
  const total = 15_000;
  const left = Math.max(0, new Date(beat.deadline).getTime() - serverNow);
  const accepted = beat.players.filter((p) => p.accepted).length;

  async function act(rpc: "arena_accept" | "arena_decline") {
    setBusy(true);
    const { error } = await sb.rpc(rpc, { p_arena: beat.arena_id });
    if (error) toast.error(error.message);
    setBusy(false);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
    >
      <motion.div
        initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
        role="dialog" aria-modal aria-labelledby="ready-title"
        className="relative w-full max-w-[520px] overflow-hidden rounded-[28px] bg-[#16131C] p-6 ring-1 ring-white/10 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F5D96B]/80 to-transparent" />
        <span aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-80 -translate-x-1/2 rounded-full bg-[#F5D96B]/10 blur-3xl" />

        <div className="relative flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#F5D96B]">Arena found</p>
            <h2 id="ready-title" className="mt-1.5 font-pixel text-3xl leading-none">{beat.players.length} players</h2>
            <p className="mt-2 text-[13px] text-white/55">{accepted}/{beat.players.length} ready · everyone must accept</p>
          </div>
          <div className="relative flex h-16 w-16 items-center justify-center">
            <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90">
              <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
              <circle cx="32" cy="32" r="28" fill="none" stroke={C.butter} strokeWidth="4" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 28} strokeDashoffset={2 * Math.PI * 28 * (1 - left / total)}
                style={{ transition: "stroke-dashoffset 0.25s linear" }} />
            </svg>
            <span className="font-pixel text-xl tabular-nums">{Math.ceil(left / 1000)}</span>
          </div>
        </div>

        <div className="relative mt-5 grid grid-cols-4 gap-2.5">
          {beat.players.map((p, i) => (
            <motion.div
              key={p.username}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, type: "spring", stiffness: 300, damping: 24 }}
              className={cn(
                "relative flex flex-col items-center gap-1.5 rounded-2xl px-1 py-2.5 transition-colors",
                p.accepted ? "bg-[#06d6a0]/10 ring-1 ring-[#06d6a0]/40" : "bg-white/[0.04] ring-1 ring-white/[0.06]"
              )}
            >
              <span className="relative">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={p.avatar_url ?? undefined} />
                  <AvatarFallback className="bg-[#17131C] text-[11px] font-bold text-[#F5D96B]">{p.username.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <AnimatePresence>
                  {p.accepted && (
                    <motion.span
                      initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 18 }}
                      className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#06d6a0] text-[#17131C] ring-2 ring-[#16131C]"
                    >
                      <Check size={11} strokeWidth={3} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className={cn("w-full truncate px-1 text-center text-[11px]", p.me ? "font-semibold text-[#F5D96B]" : "text-white/75")}>
                {p.me ? "You" : p.display_name ?? p.username}
              </span>
              <span className="text-[10px] tabular-nums text-white/40">{p.elo}</span>
            </motion.div>
          ))}
        </div>

        <div className="relative mt-6 flex gap-2.5">
          {beat.me_accepted ? (
            <div className="flex flex-1 items-center justify-center gap-2 rounded-full bg-white/[0.05] py-3 text-sm text-white/70">
              <Loader2 size={15} className="animate-spin" /> Waiting for the others…
            </div>
          ) : (
            <>
              <button
                onClick={() => act("arena_decline")} disabled={busy}
                className="rounded-full px-5 py-3 text-sm font-semibold text-white/70 ring-1 ring-white/15 transition hover:bg-white/5 disabled:opacity-50"
              >
                Decline
              </button>
              <motion.button
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                onClick={() => act("arena_accept")} disabled={busy} autoFocus
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#06d6a0] py-3 text-sm font-semibold text-[#17131C] shadow-[0_10px_30px_-10px_#06d6a0] disabled:opacity-70"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} strokeWidth={3} />} Accept
              </motion.button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─────────────────────────── Game ─────────────────────────── */

function ArenaGame({ sb, arenaId, serverNow }: { sb: SB; arenaId: string; serverNow: number }) {
  const [state, setState] = useState<ArenaState | null>(null);
  const [q, setQ] = useState<Question | null>(null);
  const [idx, setIdx] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [reveal, setReveal] = useState<{ correct: boolean; points: number; skipped: boolean } | null>(null);
  const submitting = useRef(false);

  const me = state?.players.find((p) => p.me);
  const myAnswered = me?.answered ?? 0;
  const done = state?.status === "completed";

  const refresh = useCallback(async () => {
    const { data, error } = await sb.rpc("get_arena_state", { p_arena: arenaId });
    if (!error && data) setState(data as ArenaState);
    return error ? null : (data as ArenaState);
  }, [sb, arenaId]);

  // standings poll (also drains vanished seats server-side)
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => { await refresh(); if (alive) t = setTimeout(loop, POLL_MS); };
    loop();
    return () => { alive = false; clearTimeout(t); };
  }, [refresh]);

  // load the question at the caller's own position (derived server-side)
  const load = useCallback(async (i: number) => {
    if (i >= 9) { setQ(null); setIdx(9); return; }
    const { data, error } = await sb.rpc("get_arena_question", { p_arena: arenaId, p_index: i });
    if (error || !data?.[0]) {
      // drained or raced: drop the index so the effect below re-derives our
      // position from the next standings poll and loads that question.
      setQ(null); setIdx(null);
      submitting.current = false;
      return;
    }
    setQ(data[0] as Question);
    setIdx(i);
    setSubmitted(false); setPicked(null); setTyped(""); setReveal(null);
    submitting.current = false;
  }, [sb, arenaId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load is an RPC; state lands after the await
    if (state && idx === null) load(myAnswered);
  }, [state, idx, myAnswered, load]);

  const submit = useCallback(async (sel: number | null, text: string | null) => {
    if (submitting.current || idx === null || idx >= 9) return;
    submitting.current = true;
    setSubmitted(true); setPicked(sel);
    const { data, error } = await sb.rpc("arena_submit_answer", {
      p_arena: arenaId, p_question_index: idx, p_selected_index: sel, p_answer_text: text,
    });
    if (error) {
      // 'stale question' / 'already answered' = the server moved us on (drain):
      // re-derive our position from fresh standings.
      await refresh();
      setQ(null); setIdx(null);
      submitting.current = false;
      return;
    }
    setReveal({ correct: data.correct, points: data.points, skipped: sel === null && !text });
    refresh();
    setTimeout(() => load(idx + 1), REVEAL_MS);
  }, [sb, arenaId, idx, load, refresh]);

  // timer + auto-skip at zero
  const startedMs = q ? new Date(q.started_at).getTime() : 0;
  const leadIn = q ? startedMs - serverNow : 0;
  const remaining = q ? Math.max(0, startedMs + q.cap_ms - serverNow) : 0;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clock-driven auto-skip; submit is an RPC round-trip
    if (q && !submitted && leadIn <= 0 && remaining <= 0) submit(null, null);
  }, [q, submitted, leadIn, remaining, submit]);

  if (done && state) return <Results state={state} />;

  return (
    <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <main className="min-w-0">
        {idx !== null && idx >= 9 ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#F5D96B]">All 9 answered</p>
            <h2 className="mt-1 font-pixel text-3xl">{me?.score ?? 0} pts</h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-white/55">
              <Loader2 size={14} className="animate-spin" />
              Waiting for {state?.players.filter((p) => (p.answered ?? 0) < 9).length ?? 0} player(s) to finish
            </p>
          </div>
        ) : !q || idx === null ? (
          <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin text-white/40" /></div>
        ) : leadIn > 0 && !reveal ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center">
            <p className="text-sm text-white/50">Question {idx + 1} in</p>
            <motion.p key={Math.ceil(leadIn / 1000)} initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="font-pixel text-6xl text-[#F5D96B]">
              {Math.ceil(leadIn / 1000)}
            </motion.p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", getSectionBadgeClass(q.section))}>{q.section}</span>
                <span className="text-sm text-white/55">Q{idx + 1} of 9</span>
              </div>
              <CountdownRing progress={remaining / q.cap_ms} remaining={remaining} size={52} section={q.section} />
            </div>
            <div className="flex gap-1">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={cn("h-1 flex-1 rounded-full", i < idx ? "bg-[#F5D96B]/70" : i === idx ? "bg-[#F5D96B]" : "bg-white/10")} />
              ))}
            </div>

            {q.passage && (
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[#222222] bg-[#111111] px-4 py-3 text-sm leading-relaxed text-[#c5e8f0]">{q.passage}</div>
            )}
            {q.passage_image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={q.passage_image_url} alt="" loading="lazy" className="max-w-full rounded-xl border border-[#222222]" />
            )}
            <div>
              <QuestionBody body={q.body} className="text-base leading-relaxed text-white" />
              {q.image_url && <QuestionDiagram url={q.image_url} />}
            </div>

            {q.qtype === "tita" ? (
              <form onSubmit={(e) => { e.preventDefault(); if (!submitted && typed.trim()) submit(null, typed); }} className="flex gap-2.5">
                <input
                  value={typed}
                  // Reject rather than sanitise (see TITA_INPUT): what the
                  // player sees is exactly what gets scored.
                  onChange={(e) => { if (TITA_INPUT.test(e.target.value)) setTyped(e.target.value); }}
                  disabled={submitted} autoFocus autoComplete="off" inputMode="decimal" placeholder="e.g. 245"
                  className="flex-1 rounded-xl border border-[#222222] bg-[#111111] px-4 py-3.5 font-mono text-base text-white outline-none placeholder:text-white/25 focus:border-[#06d6a0]/60"
                />
                <button type="submit" disabled={submitted || !typed.trim()} className="rounded-xl bg-[#06d6a0] px-6 font-semibold text-[#17131C] disabled:opacity-40">Submit</button>
              </form>
            ) : (
              <div className="space-y-2.5">
                {q.options.map((opt, i) => (
                  <button
                    key={i} onClick={() => submit(i, null)} disabled={submitted}
                    className={cn(
                      "w-full rounded-xl border px-4 py-3.5 text-left text-sm transition-colors",
                      submitted && picked === i
                        ? reveal ? (reveal.correct ? "border-[#06d6a0] bg-[#06d6a0]/15" : "border-[#ef476f] bg-[#ef476f]/15") : "border-white/30 bg-white/5"
                        : submitted ? "border-[#222222] bg-[#111111]/40 text-white/50"
                        : "border-[#222222] bg-[#111111] hover:border-[#06d6a0]/40 hover:bg-[#06d6a0]/5"
                    )}
                  >
                    <span className="mr-2.5 font-mono text-white/45">{String.fromCharCode(65 + i)}.</span>{opt}
                  </button>
                ))}
              </div>
            )}

            <div className="flex h-10 items-center justify-center">
              <AnimatePresence mode="wait">
                {reveal ? (
                  <motion.span
                    key="r" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 18 }}
                    className={cn("rounded-full px-4 py-1.5 text-sm font-bold",
                      reveal.skipped ? "bg-white/10 text-white/70" : reveal.correct ? "bg-[#06d6a0]/15 text-[#06d6a0]" : "bg-[#ef476f]/15 text-[#ef476f]")}
                  >
                    {reveal.skipped ? "Skipped · 0" : `${reveal.points > 0 ? "+" : ""}${reveal.points} pts`}
                  </motion.span>
                ) : !submitted ? (
                  <motion.button key="s" onClick={() => submit(null, null)} className="text-sm text-white/50 hover:text-white">Skip · 0 pts</motion.button>
                ) : (
                  <Loader2 key="l" size={16} className="animate-spin text-white/40" />
                )}
              </AnimatePresence>
            </div>
          </div>
        )}
      </main>

      <Standings players={state?.players ?? []} />
    </div>
  );
}

// Live standings: progress only (scores stay hidden until everyone finishes —
// the same liveness-only rule the 1v1 broadcast follows). Own score shown.
function Standings({ players }: { players: Seat[] }) {
  return (
    <aside className="relative h-fit overflow-hidden rounded-[24px] bg-[#1B1723] p-4 ring-1 ring-white/[0.08] lg:sticky lg:top-5">
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#F5D96B]/70 to-transparent" />
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/80">
        <span className="h-1.5 w-1.5 rounded-full bg-[#F5D96B]" /> Arena · {players.length} players
      </p>
      <ul className="space-y-2">
        {players.map((p) => (
          <motion.li layout key={p.username} className={cn("rounded-2xl px-3 py-2", p.me ? "bg-[#F5D96B]/10 ring-1 ring-[#F5D96B]/40" : "bg-white/[0.04]")}>
            <div className="flex items-center gap-2.5">
              <Avatar className="h-7 w-7">
                <AvatarImage src={p.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#17131C] text-[10px] font-bold text-[#F5D96B]">{p.username.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.me ? "You" : p.display_name ?? p.username}</span>
              <span className="text-[11px] tabular-nums text-white/55">{p.me && p.score != null ? `${p.score} pts` : `${p.answered ?? 0}/9`}</span>
            </div>
            <div className="mt-2 flex gap-0.5">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i < (p.answered ?? 0) ? (p.me ? "bg-[#F5D96B]" : "bg-white/50") : "bg-white/10")} />
              ))}
            </div>
          </motion.li>
        ))}
      </ul>
    </aside>
  );
}

/* ─────────────────────────── Results ─────────────────────────── */

const PODIUM = [
  { color: C.butter, h: "h-28" },
  { color: C.peri, h: "h-20" },
  { color: C.rose, h: "h-14" },
];

function Results({ state }: { state: ArenaState }) {
  const ranked = [...state.players].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const me = ranked.find((p) => p.me);
  const myDelta = me && me.elo_after != null && me.elo_before != null ? me.elo_after - me.elo_before : null;
  // podium order: 2nd, 1st, 3rd
  const podium = [ranked[1], ranked[0], ranked[2]].map((p, i) => ({ p, slot: [1, 0, 2][i] }));

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#F5D96B]">Arena complete</p>
        <motion.h1
          initial={{ scale: 1.6, opacity: 0, rotate: -6 }} animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 14, delay: 0.15 }}
          className="mt-1 font-pixel text-4xl"
        >
          {me?.rank ? `#${me.rank} of ${ranked.length}` : "Finished"}
        </motion.h1>
        {myDelta !== null && (
          <p className={cn("mt-2 text-lg font-bold tabular-nums", myDelta > 0 ? "text-[#06d6a0]" : myDelta < 0 ? "text-[#ef476f]" : "text-white/60")}>
            {myDelta > 0 ? "+" : ""}{myDelta} ELO
          </p>
        )}
      </motion.div>

      <div className="mt-8 flex items-end justify-center gap-3">
        {podium.map(({ p, slot }, i) => p && (
          <motion.div
            key={p.username}
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 220, damping: 22, delay: 0.3 + i * 0.1 }}
            className="flex w-28 flex-col items-center gap-2"
          >
            {slot === 0 && <CrownIcon size={20} className="text-[#F5D96B]" fill="currentColor" />}
            <Avatar className="h-12 w-12" style={{ boxShadow: `0 0 0 2px ${PODIUM[slot].color}` }}>
              <AvatarImage src={p.avatar_url ?? undefined} />
              <AvatarFallback className="bg-[#17131C] text-xs font-bold">{p.username.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="w-full truncate text-center text-xs font-semibold">{p.me ? "You" : p.display_name ?? p.username}</span>
            <div className={cn("relative isolate flex w-full items-start justify-center overflow-hidden rounded-t-2xl pt-2 text-[#17131C]", PODIUM[slot].h)} style={{ backgroundColor: PODIUM[slot].color }}>
              {slot === 0 && <Shuriken color={C.butterTone} className="-bottom-6 -right-6 -z-10 h-20 w-20" spin />}
              <span className="font-pixel text-2xl">{slot + 1}</span>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="overflow-hidden rounded-[24px] bg-[#1B1723] ring-1 ring-white/[0.08]">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wide text-white/45">
            <tr><th className="px-4 py-3 text-left">#</th><th className="text-left">Player</th><th className="text-right">Correct</th><th className="text-right">Score</th><th className="px-4 text-right">ELO</th></tr>
          </thead>
          <tbody>
            {ranked.map((p, i) => {
              const d = p.elo_after != null && p.elo_before != null ? p.elo_after - p.elo_before : null;
              return (
                <motion.tr
                  key={p.username}
                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.5 + i * 0.05 }}
                  className={cn("border-t border-white/[0.05]", p.me && "bg-[#F5D96B]/[0.07]")}
                >
                  <td className="px-4 py-2.5 font-pixel">{p.rank}</td>
                  <td className="max-w-0 truncate font-medium">{p.me ? "You" : p.display_name ?? p.username}</td>
                  <td className="text-right tabular-nums text-white/70">{p.correct}/9</td>
                  <td className="text-right font-semibold tabular-nums">{p.score}</td>
                  <td className={cn("px-4 text-right font-semibold tabular-nums", d && d > 0 ? "text-[#06d6a0]" : d && d < 0 ? "text-[#ef476f]" : "text-white/50")}>
                    {d === null ? "—" : `${d > 0 ? "+" : ""}${d}`}
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex justify-center gap-3">
        <Link href="/lobby" className="rounded-full px-5 py-2.5 text-sm font-semibold ring-1 ring-white/15 hover:bg-white/5">Lobby</Link>
        <a href="/arena" className="rounded-full bg-[#06d6a0] px-5 py-2.5 text-sm font-semibold text-[#17131C]">Play again</a>
      </div>
    </div>
  );
}
