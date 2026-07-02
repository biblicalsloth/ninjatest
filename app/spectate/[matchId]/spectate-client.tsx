"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Eye } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CountdownRing } from "@/components/countdown-ring";
import { SpeedMeter } from "@/components/speed-meter";
import type { MatchQuestion, CatSection, MatchStatus } from "@/lib/supabase/types";
import { getSectionBadgeClass, cn } from "@/lib/utils";

interface SpectatorMatch {
  match_id: string;
  status: MatchStatus;
  current_index: number;
  score_a: number;
  score_b: number;
  player_a_username: string;
  player_a_avatar: string | null;
  player_b_username: string;
  player_b_avatar: string | null;
}

interface Props {
  initialMatch: SpectatorMatch;
}

// Read-only: no submit_answer, no presence tracking (spectators don't count
// toward opponent-presence/forfeit logic), broadcast-only for live updates —
// see supabase/migrations/20260702000600_spectate_mode.sql.
export default function SpectateClient({ initialMatch }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const currentMatchRef = useRef(initialMatch);

  const [match, setMatch] = useState(initialMatch);
  const [question, setQuestion] = useState<MatchQuestion | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [clockOffset, setClockOffset] = useState(0);

  /* One-time clock sync */
  useEffect(() => {
    const t0 = Date.now();
    supabase.from("section_config").select("section").limit(1).then(() => {
      setClockOffset(-(Date.now() - t0) / 2);
    });
  }, [supabase]);

  const fetchQuestion = useCallback(async (matchId: string, index: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("get_match_question_spectator", {
      p_match_id: matchId,
      p_index: index,
    });
    if (error || !data?.[0]) { setQuestion(null); return; }
    setQuestion(data[0] as unknown as MatchQuestion);
  }, [supabase]);

  useEffect(() => {
    if (match.status === "active") fetchQuestion(match.match_id, match.current_index);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Broadcast-only channel — no postgres_changes (would need matches RLS
     opened beyond participants), no presence track(). */
  useEffect(() => {
    const channel = supabase
      .channel(`match:${match.match_id}`)
      .on("broadcast", { event: "spectator_update" }, (payload) => {
        const p = payload.payload as {
          match_id: string; status: MatchStatus; current_index: number;
          score_a: number; score_b: number;
        };
        const prevIndex = currentMatchRef.current.current_index;
        const updated = { ...currentMatchRef.current, ...p };
        currentMatchRef.current = updated;
        setMatch(updated);
        if (p.status !== "active") return;
        if (p.current_index !== prevIndex) fetchQuestion(match.match_id, p.current_index);
      })
      .subscribe();

    return () => { channel.unsubscribe(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.match_id, fetchQuestion]);

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

  if (match.status !== "active" || !question) {
    return (
      <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4 gap-4">
        <p className="text-white text-lg font-semibold">
          {match.status === "completed" ? "Match ended" : "Loading…"}
        </p>
        {match.status === "completed" && (
          <p className="text-[#7ab5cc] text-sm">
            {match.player_a_username} {match.score_a} — {match.score_b} {match.player_b_username}
          </p>
        )}
        <button
          onClick={() => router.push("/spectate")}
          className="text-[#06d6a0] text-sm font-medium hover:underline"
        >
          Back to live matches
        </button>
      </div>
    );
  }

  const capMs = question.cap_ms;
  const progressPct = timeRemaining / capMs;
  const section = question.section as CatSection;
  const options = question.options as string[];

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col">
      <div className="bg-[#120F17] border-b border-[#222222] px-4 py-3">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <Link href="/spectate" className="text-[#7ab5cc] hover:text-white transition-colors flex items-center gap-1.5 text-sm">
              <ArrowLeft size={14} />
              Back
            </Link>
            <span className="text-[#7ab5cc] text-xs flex items-center gap-1.5">
              <Eye size={12} />
              Spectating
            </span>
          </div>

          <div className="flex items-center justify-center gap-1.5 mb-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "w-2 h-2 rounded-full transition-colors",
                  i < match.current_index
                    ? "bg-[#06d6a0]/60"
                    : i === match.current_index
                    ? "bg-[#06d6a0] w-3 h-3"
                    : "bg-[#1a6080]"
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-3">
            <SpectatorPlayerBar username={match.player_a_username} avatar={match.player_a_avatar} score={match.score_a} align="left" />
            <div className="flex flex-col items-center gap-1 shrink-0">
              <CountdownRing progress={progressPct} remaining={timeRemaining} size={56} section={section} />
            </div>
            <SpectatorPlayerBar username={match.player_b_username} avatar={match.player_b_avatar} score={match.score_b} align="right" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
          <div className="flex items-center gap-2">
            <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-md", getSectionBadgeClass(section))}>
              {section}
            </span>
            <span className="text-[#7ab5cc] text-sm">
              Q{match.current_index + 1} of 9
            </span>
          </div>

          <SpeedMeter progress={progressPct} section={section} capMs={capMs} timeRemaining={timeRemaining} />

          <div className="text-white text-base leading-relaxed whitespace-pre-wrap">
            {question.body}
          </div>

          <div className="space-y-2.5">
            {options.map((opt, i) => (
              <div
                key={i}
                className="w-full text-left px-4 py-3.5 rounded-xl border text-sm border-[#222222] bg-[#111111] text-white"
              >
                <span className="text-[#7ab5cc] font-mono mr-2.5">
                  {String.fromCharCode(65 + i)}.
                </span>
                {opt}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SpectatorPlayerBar({
  username,
  avatar,
  score,
  align,
}: {
  username: string;
  avatar: string | null;
  score: number;
  align: "left" | "right";
}) {
  return (
    <div className={cn("flex-1 flex items-center gap-2", align === "left" ? "flex-row" : "flex-row-reverse")}>
      <Avatar className="w-9 h-9 shrink-0">
        <AvatarImage src={avatar ?? undefined} />
        <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-xs font-bold">
          {username.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className={cn("min-w-0", align === "left" ? "text-left" : "text-right")}>
        <p className="text-white text-sm font-semibold truncate">{username}</p>
        <p className="text-[#ffd166] font-bold text-lg leading-none">{score}</p>
      </div>
    </div>
  );
}
