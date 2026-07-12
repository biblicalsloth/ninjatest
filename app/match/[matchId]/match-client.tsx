"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CountdownRing } from "@/components/countdown-ring";
import { SpeedMeter } from "@/components/speed-meter";
import { Button } from "@/components/ui/button";
import type { Match, Profile, MatchQuestion, CatSection } from "@/lib/supabase/types";
import { getSectionBadgeClass, formatPoints, cn } from "@/lib/utils";

interface Props {
  match: Match;
  myProfile: Profile;
  oppProfile: Profile;
  isPlayerA: boolean;
  userId: string;
}

interface RevealData {
  correct_index: number;
  explanation: string | null;
  points_awarded: number;
  is_correct: boolean;
}

export default function MatchClient({ match, myProfile, oppProfile, isPlayerA, userId }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const forfeitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmitFiredRef = useRef(false);
  const currentMatchRef = useRef(match);
  const questionRef = useRef<MatchQuestion | null>(null);

  const [currentMatch, setCurrentMatch] = useState(match);
  const [question, setQuestion] = useState<MatchQuestion | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [oppAnswered, setOppAnswered] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [clockOffset, setClockOffset] = useState(0);

  const [showReveal, setShowReveal] = useState(false);
  const [revealData, setRevealData] = useState<RevealData | null>(null);
  const [revealCountdown, setRevealCountdown] = useState(3);
  const pendingAdvanceRef = useRef<{ newIndex: number; matchState: Match } | null>(null);
  const matchStartedRef = useRef(match.status !== "pending");

  const myScore = isPlayerA ? currentMatch.score_a : currentMatch.score_b;
  const oppScore = isPlayerA ? currentMatch.score_b : currentMatch.score_a;

  /* One-time clock sync */
  useEffect(() => {
    const t0 = Date.now();
    supabase.from("section_config").select("section").limit(1).then(() => {
      setClockOffset(-(Date.now() - t0) / 2);
    });
  }, [supabase]);

  /* Fetch question for given index */
  const fetchQuestion = useCallback(async (index: number) => {
    setSelected(null);
    setSubmitted(false);
    setOppAnswered(false);
    setShowReveal(false);
    setRevealData(null);
    autoSubmitFiredRef.current = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("get_match_question", {
      p_match_id: currentMatch.id,
      p_index: index,
    });
    if (error || !data || !data[0]) {
      toast.error("Failed to load question");
      return;
    }
    const q = data[0] as unknown as MatchQuestion;
    questionRef.current = q;
    setQuestion(q);
  }, [currentMatch.id, supabase]);

  /* Rehydrate match state from DB — called on reconnect or channel error */
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
    await fetchQuestion(m.current_index);
  }, [match.id, supabase, router, fetchQuestion]);

  /* Load Q0 if match already active (pending waits for presence to fire start_match) */
  useEffect(() => {
    if (match.status !== "pending") {
      fetchQuestion(match.current_index);
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
      const remaining = Math.max(0, cap - (now - startedAt));
      setTimeRemaining(remaining);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [question, clockOffset]);

  /* Auto-submit null when timer hits 0 */
  useEffect(() => {
    if (timeRemaining === 0 && question && !submitted && !autoSubmitFiredRef.current) {
      autoSubmitFiredRef.current = true;
      handleSubmit(null);
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
          p_question_index: currentMatchRef.current.current_index,
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
            currentMatchRef.current = pending.matchState;
            setCurrentMatch(pending.matchState);
            fetchQuestion(pending.newIndex);
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
      if (forfeitTimerRef.current) { clearTimeout(forfeitTimerRef.current); forfeitTimerRef.current = null; }
    }
    function scheduleForfeit() {
      clearForfeit();
      // 30s total: 10s page-load buffer + 20s spec grace = 30s before forfeit fires.
      // Server-side guard still enforces the 20s minimum from question_started_at.
      forfeitTimerRef.current = setTimeout(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).rpc("forfeit_match", { p_match_id: match.id });
      }, 30_000);
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
        const prevIndex = currentMatchRef.current.current_index;

        if (updated.status === "completed" || updated.status === "abandoned") {
          clearForfeit();
          if (questionRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data } = await (supabase as any).rpc("get_answer_reveal", {
              p_match_id: match.id,
              p_index: prevIndex,
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

        if (updated.current_index !== prevIndex) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data } = await (supabase as any).rpc("get_answer_reveal", {
            p_match_id: match.id,
            p_index: prevIndex,
          });
          if (data?.[0]) {
            setRevealData(data[0] as RevealData);
            setShowReveal(true);
            pendingAdvanceRef.current = { newIndex: updated.current_index, matchState: updated };
          } else {
            currentMatchRef.current = updated;
            setCurrentMatch(updated);
            await fetchQuestion(updated.current_index);
          }
        }
      })
      .on("broadcast", { event: "opponent_answered" }, () => {
        setOppAnswered(true);
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
        } else if (!forfeitTimerRef.current) {
          scheduleForfeit();
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ user_id: userId });
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

  /* Submit answer (null = skip) */
  async function handleSubmit(optionIndex: number | null) {
    if (submitted || !question) return;
    setSelected(optionIndex);
    setSubmitted(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("submit_answer", {
      p_match_id: currentMatch.id,
      p_question_index: currentMatch.current_index,
      p_selected_index: optionIndex,
    });

    if (error) {
      toast.error("Failed to submit: " + error.message);
      setSubmitted(false);
      setSelected(null);
      autoSubmitFiredRef.current = false;
    } else {
      channelRef.current?.send({
        type: "broadcast",
        event: "opponent_answered",
        payload: {},
      });
    }
  }

  /* ── Reveal screen ── */
  if (showReveal && revealData && question) {
    const options = question.options as string[];
    return (
      <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl space-y-5">
          {/* Result badge */}
          <div className="flex items-center justify-between">
            <span className={cn(
              "text-sm font-bold px-3 py-1 rounded-full",
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

          {/* Question body */}
          <p className="text-white text-base leading-relaxed whitespace-pre-wrap">
            {question.body}
          </p>

          {/* Options with correct/wrong highlighting */}
          <div className="space-y-2.5">
            {options.map((opt, i) => {
              const isCorrect = i === revealData.correct_index;
              const isMyPick = i === selected;
              return (
                <div
                  key={i}
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

          {/* Explanation */}
          {revealData.explanation && (
            <div className="bg-[#111111] rounded-xl px-4 py-3 text-[#c5e8f0] text-sm leading-relaxed">
              <span className="text-[#06d6a0] font-semibold mr-1">Why:</span>
              {revealData.explanation}
            </div>
          )}
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

  const capMs = question.cap_ms;
  const progressPct = timeRemaining / capMs;
  const section = question.section as CatSection;
  const options = question.options as string[];

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col">
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
                  i < currentMatch.current_index
                    ? "bg-[#06d6a0]/60"
                    : i === currentMatch.current_index
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
            <PlayerBar profile={oppProfile} score={oppScore} answered={oppAnswered} />
          </div>
        </div>
      </div>

      {/* Question area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
          {/* Section + Q number */}
          <div className="flex items-center gap-2">
            <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-md", getSectionBadgeClass(section))}>
              {section}
            </span>
            <span className="text-[#7ab5cc] text-sm">
              Q{currentMatch.current_index + 1} of 9
            </span>
          </div>

          {/* Speed meter */}
          <SpeedMeter
            progress={progressPct}
            section={section}
            capMs={capMs}
            timeRemaining={timeRemaining}
          />

          {/* Shared passage (passage-group questions only) */}
          {question.passage && (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-[#222222] bg-[#111111] px-4 py-3 text-[#c5e8f0] text-sm leading-relaxed whitespace-pre-wrap">
              {question.passage}
            </div>
          )}

          {/* Question body */}
          <div className="text-white text-base leading-relaxed whitespace-pre-wrap">
            {question.body}
          </div>

          {/* Options */}
          <div className="space-y-2.5">
            {options.map((opt, i) => (
              <button
                key={i}
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
              <p className="text-[#4a8fa8] text-xs">Wrong answer: −30 pts</p>
            </div>
          ) : (
            <div className="text-center py-2">
              <p className="text-[#c5e8f0] text-sm">
                {oppAnswered
                  ? "Both answered — waiting for next question…"
                  : selected === null
                  ? "Skipped — waiting for opponent…"
                  : "Answer submitted — waiting for opponent…"}
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
}: {
  profile: Profile;
  score: number;
  isMe?: boolean;
  answered?: boolean;
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
        <p className="text-white text-sm font-semibold truncate">{profile.display_name ?? profile.username}</p>
        <p className="text-[#ffd166] font-bold text-lg leading-none">{score}</p>
        {!isMe && answered && (
          <p className="text-[#7ab5cc] text-xs">answered</p>
        )}
      </div>
    </div>
  );
}
