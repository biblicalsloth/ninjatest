"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CountdownRing } from "@/components/countdown-ring";
import { QuestionBody } from "@/components/question-body";
import { QuestionDiagram } from "@/components/question-diagram";
import { SpeedMeter } from "@/components/speed-meter";
import { Button } from "@/components/ui/button";
import type { Match, Profile, MatchQuestion, CatSection } from "@/lib/supabase/types";
import { getSectionBadgeClass, formatPoints, cn } from "@/lib/utils";
import { gsap, useGSAP, enterUp, stamp, countTo, prefersReduced, DUR, EASE } from "@/lib/motion";

interface Props {
  match: Match;
  myProfile: Profile;
  oppProfile: Profile;
  isPlayerA: boolean;
  userId: string;
}

interface RevealData {
  correct_index: number | null;
  qtype: "mcq" | "tita";
  /** tita only: the expected answer */
  answer_value: string | null;
  /** tita only: what this player typed (null = skipped) */
  my_answer_text: string | null;
  explanation: string | null;
  points_awarded: number;
  is_correct: boolean;
}

// TITA answers are numeric — the DB enforces it (questions_tita_answer_numeric),
// so the box can refuse everything else. Permissive enough to type THROUGH:
// "", "-", "1,", "1900." are all valid intermediate states. Rejects the inputs
// that scored a right solve as wrong: "Rs.1900", "1900m", "1900 metres".
const TITA_INPUT = /^-?[0-9]*(?:,[0-9]*)*(?:\.[0-9]*)?$/;

export default function MatchClient({ match, myProfile, oppProfile, isPlayerA, userId }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const forfeitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSubmitFiredRef = useRef(false);
  const currentMatchRef = useRef(match);
  const questionRef = useRef<MatchQuestion | null>(null);
  // Mirrors typedAnswer so the deadline auto-submit (which runs on a stale
  // closure) can send what the player actually typed instead of a skip.
  const typedAnswerRef = useRef("");

  const [currentMatch, setCurrentMatch] = useState(match);
  // My OWN position through the 9 questions. Self-paced (human) matches advance
  // this per-player, independent of the opponent; it is NOT matches.current_index
  // (which the server keeps at the lagging player's index for spectators). Bot
  // matches stay shared, so there qIndex tracks current_index.
  const [qIndex, setQIndex] = useState(match.current_index);
  const qIndexRef = useRef(match.current_index);
  const [question, setQuestion] = useState<MatchQuestion | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [oppAnswered, setOppAnswered] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [startsIn, setStartsIn] = useState(0); // ms of pre-Q1 lead-in, 0 once live
  const [clockOffset, setClockOffset] = useState(0);

  const [showReveal, setShowReveal] = useState(false);
  const [revealData, setRevealData] = useState<RevealData | null>(null);
  const [revealCountdown, setRevealCountdown] = useState(3);
  const pendingAdvanceRef = useRef<{ newIndex: number; matchState?: Match } | null>(null);
  const matchStartedRef = useRef(match.status !== "pending");
  const fetchRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // fetchQuestion's stuck-retry must re-derive my index via rehydrate (the cron
  // may have drained me past it), but rehydrate is defined after fetchQuestion —
  // bridge the cycle with a ref.
  const rehydrateRef = useRef<() => Promise<void>>(async () => {});

  const myScore = isPlayerA ? currentMatch.score_a : currentMatch.score_b;
  const oppScore = isPlayerA ? currentMatch.score_b : currentMatch.score_a;

  // Bot matches: created active (no presence handshake), the bot never joins
  // presence (so the forfeit path must not fire), and this client drives the
  // bot via the poll-safe bot_act RPC.
  const isBotMatch = Boolean((oppProfile as unknown as { is_bot?: boolean }).is_bot);

  /* One-time clock sync: offset = server clock − client clock, estimated at
     the request midpoint. Corrects absolute skew (a fast client clock used to
     auto-skip early; a slow one submitted past the server deadline). */
  useEffect(() => {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_server_time").then(
      ({ data }: { data: string | null }) => {
        if (!data) return;
        const t1 = Date.now();
        setClockOffset(new Date(data).getTime() - (t0 + t1) / 2);
      },
      () => {}
    );
  }, [supabase]);

  /* Fetch question for given index */
  const fetchQuestion = useCallback(async (index: number) => {
    setSelected(null);
    setTypedAnswer("");
    typedAnswerRef.current = "";
    setSubmitted(false);
    setOppAnswered(false);
    setShowReveal(false);
    setRevealData(null);
    autoSubmitFiredRef.current = false;

    // Retry transient failures — the server clock is already running, so a
    // silent bail costs the player the whole question (cron logs a NULL skip).
    for (let attempt = 0; attempt < 3; attempt++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("get_match_question", {
        p_match_id: currentMatch.id,
        p_index: index,
      });
      if (!error && data && data[0]) {
        const q = data[0] as unknown as MatchQuestion;
        questionRef.current = q;
        setQuestion(q);
        setQIndex(index);
        qIndexRef.current = index;
        return;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
    toast.error("Failed to load question — retrying on next update");
    // Self-paced: an idle/finished opponent produces no further UPDATEs, so
    // without a self-scheduled retry this player would sit on "Loading
    // question…" while their server clock burns down to a NULL skip. Retry via
    // rehydrate, NOT fetchQuestion(index): while we were failing, the cron may
    // have drained my clock past `index` (or the match ended) — a blind refetch
    // of the same index then fails 'not current question' forever, which is
    // exactly the "questions failed to load repeatedly" stuck loop. Rehydrate
    // re-derives my index from my answer count and routes to the result when
    // the match is over.
    if (fetchRetryRef.current) clearTimeout(fetchRetryRef.current);
    fetchRetryRef.current = setTimeout(() => {
      if (qIndexRef.current !== index || !questionRef.current) void rehydrateRef.current();
    }, 4000);
  }, [currentMatch.id, supabase]);

  useEffect(() => () => {
    if (fetchRetryRef.current) clearTimeout(fetchRetryRef.current);
  }, []);

  /* My own progress: derived from my answer count (self-paced) — the server
     keeps no per-player index column. Bot matches stay on the shared index. */
  const resolveMyIndex = useCallback(async (m: Match): Promise<number> => {
    if (isBotMatch) return m.current_index;
    const { count } = await supabase
      .from("match_answers")
      .select("*", { count: "exact", head: true })
      .eq("match_id", m.id)
      .eq("user_id", userId);
    return count ?? 0;
  }, [isBotMatch, supabase, userId]);

  /* Rehydrate match state from DB — called on reconnect or channel error.
     Resumes at MY current question against the server clock; never bounces to
     the lobby while my match is still live. */
  const rehydrate = useCallback(async () => {
    const { data } = await supabase.from("matches").select("*").eq("id", match.id).single();
    if (!data) { router.push(`/result/${match.id}`); return; }
    const m = data as Match;
    if (m.status === "completed" || m.status === "abandoned") {
      router.push(`/result/${match.id}`);
      return;
    }
    currentMatchRef.current = m;
    setCurrentMatch(m);
    if (m.status === "active") {
      const idx = await resolveMyIndex(m);
      if (idx >= 9) { router.push(`/result/${match.id}`); return; } // I finished
      await fetchQuestion(idx);
    }
  }, [match.id, supabase, router, fetchQuestion, resolveMyIndex]);
  rehydrateRef.current = rehydrate;

  /* Load my current question if the match is already active (pending waits for
     presence to fire start_match) */
  useEffect(() => {
    if (match.status !== "pending") {
      void (async () => {
        const idx = await resolveMyIndex(match);
        if (idx >= 9) { router.push(`/result/${match.id}`); return; }
        await fetchQuestion(idx);
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Countdown timer */
  useEffect(() => {
    if (!question) return;
    const cap = question.cap_ms;
    const startedAt = new Date(question.started_at).getTime();

    const tick = () => {
      const now = Date.now() + clockOffset;
      // start_match sets Q1's started_at 3s ahead → a shared lead-in countdown.
      // During it, elapsed clamps to 0 so the question timer stays at full cap
      // and can't auto-submit early.
      setStartsIn(Math.max(0, startedAt - now));
      const elapsed = Math.max(0, now - startedAt);
      setTimeRemaining(Math.max(0, cap - elapsed));
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [question, clockOffset]);

  /* Deadline reached: auto-submit. For TITA send whatever is in the box — a
     typed-but-unsubmitted answer is an answer, not a skip. MCQ has no partial
     state, so it stays a null skip. */
  useEffect(() => {
    if (timeRemaining === 0 && question && !submitted && !autoSubmitFiredRef.current) {
      autoSubmitFiredRef.current = true;
      handleSubmit(null, question.qtype === "tita" ? typedAnswerRef.current || null : null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRemaining, question, submitted]);

  /* Anti-cheat telemetry: log tab/window focus loss during a live match.
     Best-effort — the server whitelists + rate-limits these; errors are ignored. */
  useEffect(() => {
    const report = (eventType: "tab_hidden" | "window_blur") => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .rpc("log_match_event", {
          p_match_id: currentMatch.id,
          p_question_index: qIndexRef.current,
          p_event_type: eventType,
        })
        .then(() => {}, () => {});
    };
    const onVis = () => { if (document.visibilityState === "hidden") report("tab_hidden"); };
    const onBlur = () => report("window_blur");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
    };
  }, [currentMatch.id, supabase]);

  /* Reveal countdown when showReveal becomes true */
  useEffect(() => {
    if (!showReveal) return;
    setRevealCountdown(3);
    const id = setInterval(() => {
      setRevealCountdown((c) => {
        if (c <= 1) {
          clearInterval(id);
          const pending = pendingAdvanceRef.current;
          if (pending) {
            pendingAdvanceRef.current = null;
            if (pending.matchState) {
              currentMatchRef.current = pending.matchState;
              setCurrentMatch(pending.matchState);
            }
            // Self-paced: past my 9th question I'm done — go to my result
            // (which shows "opponent still answering" until they finish).
            if (pending.newIndex >= 9) {
              router.push(`/result/${match.id}`);
            } else {
              fetchQuestion(pending.newIndex);
            }
          }
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReveal]);

  /* Realtime: match changes + broadcast + presence */
  useEffect(() => {
    const oppId = isPlayerA ? match.player_b : match.player_a;

    function clearForfeit() {
      if (forfeitTimerRef.current) { clearInterval(forfeitTimerRef.current); forfeitTimerRef.current = null; }
    }
    function scheduleForfeit() {
      clearForfeit();
      // Opponent looks absent — keep attempting a forfeit until the server
      // accepts it (it rejects until the opponent has verifiably missed a full
      // question deadline) or presence sees them return (clearForfeit). The
      // old single-shot attempt always fired inside the deadline, got
      // rejected, and never retried — the forfeit path was effectively dead.
      // Errors are ignored; success arrives via the match UPDATE event.
      forfeitTimerRef.current = setInterval(() => {
        // Backgrounded tab: skip the ping. The advance_timed_out cron resolves
        // an absent opponent within ~2min regardless, so a hidden tab needn't
        // hammer the RPC every 10s.
        if (document.hidden) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc("forfeit_match", { p_match_id: match.id }).then(() => {}, () => {});
      }, 10_000);
    }

    const channel = supabase
      .channel(`match:${currentMatch.id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "matches",
        filter: `id=eq.${currentMatch.id}`,
      }, async (payload) => {
        const updated = payload.new as Match;
        const prevBotIndex = currentMatchRef.current.current_index;

        if (updated.status === "completed" || updated.status === "abandoned") {
          clearForfeit();
          if (questionRef.current && !submitted) {
            // Only reveal if I was still mid-question (e.g. opponent forfeited
            // me). If I already finished I'm being routed to my result anyway.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data } = await (supabase as any).rpc("get_answer_reveal", {
              p_match_id: match.id,
              p_index: qIndexRef.current,
            });
            if (data?.[0]) {
              setRevealData(data[0] as RevealData);
              setShowReveal(true);
              pendingAdvanceRef.current = null;
              setTimeout(() => router.push(`/result/${currentMatch.id}`), 3000);
              return;
            }
          }
          router.push(`/result/${currentMatch.id}`);
          return;
        }

        // Keep the opponent's score/liveness fresh (matches row carries both
        // scores). My OWN progress is self-paced and never driven from here.
        currentMatchRef.current = updated;
        setCurrentMatch(updated);

        // Bot matches only: the shared current_index drives advancement.
        if (isBotMatch && updated.current_index !== prevBotIndex) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data } = await (supabase as any).rpc("get_answer_reveal", {
            p_match_id: match.id,
            p_index: prevBotIndex,
          });
          if (data?.[0]) {
            setRevealData(data[0] as RevealData);
            setShowReveal(true);
            pendingAdvanceRef.current = { newIndex: updated.current_index, matchState: updated };
          } else {
            await fetchQuestion(updated.current_index);
          }
        }
      })
      .on("broadcast", { event: "opponent_answered" }, () => {
        setOppAnswered(true);
        // Instant liveness ping — broadcast carries no score/correctness.
        // dismissible + short id so rapid rounds don't stack toasts.
        toast(`${oppProfile.display_name ?? oppProfile.username} answered`, {
          id: "opp-answered",
          duration: 1500,
          icon: "⚡",
        });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ user_id: string }>();
        const oppOnline = Object.values(state).flat().some((p) => p.user_id === oppId);
        if (oppOnline) {
          clearForfeit();
          // Both present: start match if still pending (idempotent on server)
          if (!matchStartedRef.current) {
            matchStartedRef.current = true;
            void (async () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (supabase as any).rpc("start_match", { p_match_id: match.id });
              await fetchQuestion(currentMatchRef.current.current_index);
            })();
          }
        } else if (!forfeitTimerRef.current && !isBotMatch) {
          scheduleForfeit();
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ user_id: userId });
          // An advance landing between the SSR fetch and this subscription
          // would otherwise be missed until the next event — re-sync now.
          await rehydrate();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          await rehydrate();
        }
      });

    channelRef.current = channel;

    window.addEventListener("online", rehydrate);
    return () => {
      clearForfeit();
      window.removeEventListener("online", rehydrate);
      channel.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch.id, fetchQuestion, rehydrate, router, supabase]);

  /* Bot driver: poll bot_act while the match is live. The server decides
     everything deterministically (answer time gate included); this just gives
     it a heartbeat. Errors ignored — the next tick retries. */
  useEffect(() => {
    if (!isBotMatch || currentMatch.status !== "active") return;
    let stopped = false;
    const act = async () => {
      if (stopped || document.hidden) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .rpc("bot_act", { p_match_id: currentMatch.id })
        .then((r: unknown) => r, () => ({ data: null }));
      if (!stopped && (data as { acted?: boolean } | null)?.acted) setOppAnswered(true);
    };
    act();
    const id = setInterval(act, 2500);
    return () => { stopped = true; clearInterval(id); };
  }, [isBotMatch, currentMatch.status, currentMatch.id, supabase]);

  /* Submit answer. MCQ: optionIndex (null = skip). TITA: answerText (null/blank
     = skip). The server decides correctness either way — it re-reads the clock,
     un-shuffles MCQ picks, and exact-matches TITA text against answer_value. */
  async function handleSubmit(optionIndex: number | null, answerText: string | null = null) {
    if (submitted || !question) return;
    setSelected(optionIndex);
    setSubmitted(true);

    const answeredIndex = qIndex;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("submit_answer", {
      p_match_id: currentMatch.id,
      p_question_index: answeredIndex,
      p_selected_index: optionIndex,
      p_answer_text: answerText,
    });

    if (error) {
      // Deterministic server verdicts, not transient failures. 'stale question' /
      // 'already answered' mean my answer already landed (a success whose
      // response was lost, or a cron drain) — unlocking the UI here would strand
      // the player resubmitting into the same error forever. 'match not active'
      // means the match ended under me. All three: re-derive my position from
      // the DB and move on (rehydrate routes to the result if the match is over).
      if (/stale question|already answered|match not active/.test(error.message)) {
        await rehydrate();
        return;
      }
      toast.error("Failed to submit: " + error.message);
      setSubmitted(false);
      setSelected(null);
      autoSubmitFiredRef.current = false;
      return;
    }

    // Liveness ping — carries no score/correctness.
    channelRef.current?.send({ type: "broadcast", event: "opponent_answered", payload: {} });

    // Self-paced (human): I advance on MY clock — show the reveal for my answer,
    // then move to my next question (or my result at 9). Bot matches wait for the
    // shared current_index to bump via postgres_changes instead.
    if (!isBotMatch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any).rpc("get_answer_reveal", {
        p_match_id: currentMatch.id,
        p_index: answeredIndex,
      });
      if (data?.[0]) {
        setRevealData(data[0] as RevealData);
        setShowReveal(true);
        pendingAdvanceRef.current = { newIndex: answeredIndex + 1 };
      } else if (answeredIndex + 1 >= 9) {
        router.push(`/result/${match.id}`);
      } else {
        await fetchQuestion(answeredIndex + 1);
      }
    }
  }

  /* ── Motion (presentation only — nothing here touches timers, submit, or
     realtime; every effect is keyed on already-committed state) ── */
  const motionScope = useRef<HTMLDivElement>(null);
  const qaVisible = !!question && startsIn === 0 && !showReveal;

  /* Question in: content rises when a new index renders. Opacity/transform
     only — options are clickable from the first frame. */
  useGSAP(
    () => {
      if (!qaVisible || prefersReduced()) return;
      enterUp("[data-anim='qa']", { y: 10, duration: 0.3, stagger: 0.05 });
    },
    { scope: motionScope, dependencies: [qIndex, qaVisible] }
  );

  /* Answer locked: quick press-settle on whatever the player committed.
     Skips have no [data-anim='pick'] element — nothing to animate. */
  useGSAP(
    () => {
      if (!submitted || prefersReduced()) return;
      const el = motionScope.current?.querySelector("[data-anim='pick']");
      if (!el) return;
      gsap.fromTo(
        el,
        { scale: 0.98 },
        { scale: 1, duration: DUR.snap, ease: EASE.settle, clearProps: "transform" }
      );
    },
    { scope: motionScope, dependencies: [submitted] }
  );

  /* Reveal punch: the ±pts verdict stamps, answer rows follow. */
  useGSAP(
    () => {
      if (!showReveal || !revealData || prefersReduced()) return;
      stamp("[data-anim='verdict']");
      enterUp("[data-anim='rrow']", { y: 8, delay: 0.1 });
    },
    { scope: motionScope, dependencies: [showReveal] }
  );

  /* ── Reveal screen ── */
  if (showReveal && revealData && question) {
    const options = question.options as string[];
    return (
      <div ref={motionScope} className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl space-y-5">
          {/* Result badge */}
          <div className="flex items-center justify-between">
            <span data-anim="verdict" className={cn(
              "inline-block text-sm font-bold px-3 py-1 rounded-full",
              revealData.is_correct
                ? "bg-[#06d6a0]/15 text-[#06d6a0]"
                : selected === null
                ? "bg-[#111111] text-[#c5e8f0]"
                : "bg-[#ef476f]/15 text-[#ef476f]"
            )}>
              {revealData.is_correct ? `+${revealData.points_awarded} pts` : selected === null ? "Skipped · 0 pts" : `${revealData.points_awarded} pts`}
            </span>
            <span className="text-[#7ab5cc] text-sm">
              {revealCountdown > 0 ? `Next in ${revealCountdown}…` : "Loading…"}
            </span>
          </div>

          {/* Shared passage (passage-group questions only) */}
          {question.passage && (
            <div className="max-h-56 overflow-y-auto rounded-xl border border-[#222222] bg-[#111111] px-4 py-3 text-[#c5e8f0] text-sm leading-relaxed whitespace-pre-wrap">
              {question.passage}
            </div>
          )}
          {question.passage_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={question.passage_image_url} alt="" loading="lazy" className="max-w-full rounded-xl border border-[#222222]" />
          )}

          {/* Question body */}
          <QuestionBody body={question.body} className="text-white text-base leading-relaxed" />
          {question.image_url && <QuestionDiagram url={question.image_url} />}

          {/* TITA reveal: expected answer vs what the player typed */}
          {revealData.qtype === "tita" ? (
            <div className="space-y-2.5">
              <div data-anim="rrow" className="px-4 py-3.5 rounded-xl border border-[#06d6a0] bg-[#06d6a0]/10">
                <div className="text-[#06d6a0] text-xs uppercase tracking-wider font-medium mb-1">
                  Correct answer
                </div>
                <div className="text-white font-mono text-base">{revealData.answer_value}</div>
              </div>
              <div
                data-anim="rrow"
                className={cn(
                  "px-4 py-3.5 rounded-xl border",
                  revealData.is_correct
                    ? "border-[#06d6a0]/40 bg-[#06d6a0]/5"
                    : revealData.my_answer_text
                    ? "border-[#ef476f]/60 bg-[#ef476f]/10"
                    : "border-[#222222] bg-[#111111]/40"
                )}
              >
                <div className="text-[#7ab5cc] text-xs uppercase tracking-wider font-medium mb-1">
                  Your answer
                </div>
                <div
                  className={cn(
                    "font-mono text-base",
                    revealData.is_correct ? "text-[#06d6a0]" : revealData.my_answer_text ? "text-[#ef476f]" : "text-[#7ab5cc]"
                  )}
                >
                  {revealData.my_answer_text ?? "Skipped"}
                  {revealData.my_answer_text && (
                    <span className="ml-2 text-xs">{revealData.is_correct ? "✓" : "✗"}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
          /* Options with correct/wrong highlighting */
          <div className="space-y-2.5">
            {options.map((opt, i) => {
              const isCorrect = i === revealData.correct_index;
              const isMyPick = i === selected;
              return (
                <div
                  key={i}
                  data-anim="rrow"
                  className={cn(
                    "w-full text-left px-4 py-3.5 rounded-xl border text-sm",
                    isCorrect
                      ? "border-[#06d6a0] bg-[#06d6a0]/10 text-white"
                      : isMyPick && !isCorrect
                      ? "border-[#ef476f]/60 bg-[#ef476f]/10 text-white"
                      : "border-[#222222] bg-[#111111]/40 text-[#7ab5cc]"
                  )}
                >
                  <span className={cn("font-mono mr-2.5", isCorrect ? "text-[#06d6a0]" : isMyPick ? "text-[#ef476f]" : "text-[#7ab5cc]")}>
                    {String.fromCharCode(65 + i)}.
                  </span>
                  {opt}
                  {isCorrect && <span className="ml-2 text-[#06d6a0] text-xs">✓</span>}
                  {isMyPick && !isCorrect && <span className="ml-2 text-[#ef476f] text-xs">✗</span>}
                </div>
              );
            })}
          </div>
          )}

          {/* No stored explanation in the reveal — correctness only. The
              worked solution comes from Ask Ninja on the result screen, not
              the PDF-parsed `explanation` column. */}
        </div>
      </div>
    );
  }

  if (!question) {
    return (
      <div className="min-h-screen bg-[#120F17] flex items-center justify-center">
        <div className="text-[#7ab5cc] text-sm">Loading question…</div>
      </div>
    );
  }

  /* ── Shared pre-Q1 countdown (both clients tick against the same server
     deadline; clockOffset-corrected so 3-2-1 lands together) ── */
  if (startsIn > 0) {
    return (
      <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4">
        <div className="flex items-center gap-4 mb-8">
          <PlayerBar profile={myProfile} score={0} isMe />
          <span className="text-[#7ab5cc] text-sm shrink-0">vs</span>
          <PlayerBar profile={oppProfile} score={0} />
        </div>
        <p className="text-[#7ab5cc] text-sm mb-3">Match starting…</p>
        <div className="text-[#06d6a0] font-bold text-7xl tabular-nums leading-none">
          {Math.ceil(startsIn / 1000)}
        </div>
      </div>
    );
  }

  const capMs = question.cap_ms;
  const progressPct = timeRemaining / capMs;
  const section = question.section as CatSection;
  const options = question.options as string[];

  return (
    <div ref={motionScope} className="min-h-screen bg-[#120F17] flex flex-col">
      {/* Top bar */}
      <div className="bg-[#120F17] border-b border-[#222222] px-4 py-3">
        <div className="max-w-2xl mx-auto">
          {/* Question dots */}
          <div className="flex items-center justify-center gap-1.5 mb-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "w-2 h-2 rounded-full transition-colors",
                  i < qIndex
                    ? "bg-[#06d6a0]/60"
                    : i === qIndex
                    ? "bg-[#06d6a0] w-3 h-3"
                    : "bg-[#1a6080]"
                )}
              />
            ))}
          </div>

          {/* Players row */}
          <div className="flex items-center gap-3">
            <PlayerBar profile={myProfile} score={myScore} isMe />
            <div className="flex flex-col items-center gap-1 shrink-0">
              <CountdownRing
                progress={progressPct}
                remaining={timeRemaining}
                size={56}
                section={section}
              />
            </div>
            <PlayerBar profile={oppProfile} score={oppScore} answered={oppAnswered} bot={isBotMatch} />
          </div>
        </div>
      </div>

      {/* Question area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
          {/* Section + Q number */}
          <div data-anim="qa" className="flex items-center gap-2">
            <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-md", getSectionBadgeClass(section))}>
              {section}
            </span>
            <span className="text-[#7ab5cc] text-sm">
              Q{qIndex + 1} of 9
            </span>
          </div>

          {/* Speed meter */}
          <div data-anim="qa">
            <SpeedMeter
              progress={progressPct}
              section={section}
              capMs={capMs}
              timeRemaining={timeRemaining}
            />
          </div>

          {/* Shared passage (passage-group questions only) */}
          {question.passage && (
            <div data-anim="qa" className="max-h-72 overflow-y-auto rounded-xl border border-[#222222] bg-[#111111] px-4 py-3 text-[#c5e8f0] text-sm leading-relaxed whitespace-pre-wrap">
              {question.passage}
            </div>
          )}
          {question.passage_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img data-anim="qa" src={question.passage_image_url} alt="" loading="lazy" className="max-w-full rounded-xl border border-[#222222]" />
          )}

          {/* Question body */}
          <div data-anim="qa">
            <QuestionBody body={question.body} className="text-white text-base leading-relaxed" />
            {question.image_url && <QuestionDiagram url={question.image_url} />}
          </div>

          {/* Answer input — TITA types a value, MCQ picks an option */}
          {question.qtype === "tita" ? (
            <form
              data-anim="qa"
              onSubmit={(e) => {
                e.preventDefault();
                if (submitted || !typedAnswer.trim()) return;
                handleSubmit(null, typedAnswer);
              }}
              className="space-y-2.5"
            >
              <label htmlFor="tita-answer" className="block text-[#7ab5cc] text-xs uppercase tracking-wider font-medium">
                Type your answer
              </label>
              <div className="flex gap-2.5">
                <input
                  id="tita-answer"
                  data-anim={submitted ? "pick" : undefined}
                  value={typedAnswer}
                  onChange={(e) => {
                    // Reject rather than sanitise. Stripping non-numerics would turn
                    // "Rs.1900" into ".1900" (= 0.19) — inventing a wrong answer out
                    // of a right one. Refusing the keystroke keeps what the player
                    // sees identical to what gets scored.
                    if (!TITA_INPUT.test(e.target.value)) return;
                    setTypedAnswer(e.target.value);
                    typedAnswerRef.current = e.target.value;
                  }}
                  disabled={submitted}
                  autoComplete="off"
                  inputMode="decimal"
                  placeholder="e.g. 245"
                  autoFocus
                  className={cn(
                    "flex-1 px-4 py-3.5 rounded-xl border bg-[#111111] text-white font-mono text-base",
                    "placeholder:text-[#7ab5cc]/40 outline-none transition-colors",
                    submitted
                      ? "border-[#222222] text-[#7ab5cc] cursor-not-allowed"
                      : "border-[#222222] focus:border-[#06d6a0]/60"
                  )}
                />
                <Button
                  type="submit"
                  disabled={submitted || !typedAnswer.trim()}
                  className="px-6 bg-[#06d6a0] text-[#073b4c] hover:bg-[#06d6a0]/90 font-semibold disabled:opacity-40"
                >
                  Submit
                </Button>
              </div>
              <p className="text-[#7ab5cc]/60 text-xs">
                No negative marking on typed answers — a wrong answer costs nothing.
              </p>
            </form>
          ) : (
            <div data-anim="qa" className="space-y-2.5">
              {options.map((opt, i) => (
                <button
                  key={i}
                  data-anim={submitted && selected === i ? "pick" : undefined}
                  onClick={() => handleSubmit(i)}
                  disabled={submitted}
                  className={cn(
                    "w-full text-left px-4 py-3.5 rounded-xl border text-sm transition-colors",
                    submitted && selected === i
                      ? "border-[#06d6a0]/60 bg-[#06d6a0]/10 text-white"
                      : submitted
                      ? "border-[#222222] bg-[#111111]/40 text-[#7ab5cc] cursor-not-allowed"
                      : "border-[#222222] bg-[#111111] text-white hover:border-[#06d6a0]/40 hover:bg-[#06d6a0]/5 active:scale-[0.99]"
                  )}
                >
                  <span className="text-[#7ab5cc] font-mono mr-2.5">
                    {String.fromCharCode(65 + i)}.
                  </span>
                  {opt}
                </button>
              ))}
            </div>
          )}

          {/* Skip / waiting */}
          {!submitted ? (
            <div className="flex flex-col items-center gap-2 pt-1">
              <Button
                variant="ghost"
                onClick={() => handleSubmit(null)}
                className="text-[#7ab5cc] hover:text-[#c5e8f0] text-sm"
              >
                Skip · 0 pts
              </Button>
              <p className="text-[#4a8fa8] text-xs">Wrong answers lose points</p>
            </div>
          ) : (
            <div className="text-center py-2">
              <p className="text-[#c5e8f0] text-sm">
                {isBotMatch ? "Answer locked in — waiting for opponent…" : "Answer locked in…"}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerBar({
  profile,
  score,
  isMe,
  answered,
  bot,
}: {
  profile: Profile;
  score: number;
  isMe?: boolean;
  answered?: boolean;
  bot?: boolean;
}) {
  return (
    <div className={cn("flex-1 flex items-center gap-2", isMe ? "flex-row" : "flex-row-reverse")}>
      <Avatar className="w-9 h-9 shrink-0">
        <AvatarImage src={profile.avatar_url ?? undefined} />
        <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-xs font-bold">
          {profile.username.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className={cn("min-w-0", isMe ? "text-left" : "text-right")}>
        <p className="text-white text-sm font-semibold truncate">
          {profile.display_name ?? profile.username}
          {bot && (
            <span className="ml-1.5 align-middle text-[9px] font-bold px-1 py-0.5 rounded bg-[#7ab5cc]/15 text-[#7ab5cc] border border-[#7ab5cc]/30">
              BOT
            </span>
          )}
        </p>
        <p className="text-[#ffd166] font-bold text-lg leading-none">
          <ScoreNumber value={score} />
        </p>
        {!isMe && answered && (
          <p className="text-[#7ab5cc] text-xs">answered</p>
        )}
      </div>
    </div>
  );
}

/* Odometer score tick — rolls between server-committed values with a small
   settle. Transform/opacity only; realtime opponent updates never shift layout. */
function ScoreNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  useGSAP(
    () => {
      const el = ref.current;
      const from = prev.current;
      prev.current = value;
      if (!el || from === value || prefersReduced()) return;
      countTo(el, from, value, { duration: 0.5 });
      gsap.fromTo(
        el,
        { scale: 1.25 },
        { scale: 1, duration: DUR.base, ease: EASE.settle, clearProps: "transform" }
      );
    },
    { dependencies: [value] }
  );
  return (
    <span ref={ref} className="inline-block tabular-nums">
      {value}
    </span>
  );
}
