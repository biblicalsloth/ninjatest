"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Trophy, RotateCcw, Home, Copy, Check, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { Match, Profile, MatchAnswer } from "@/lib/supabase/types";
import { cn, formatPoints } from "@/lib/utils";

interface Props {
  match: Match;
  myProfile: Profile;
  oppProfile: Profile;
  isPlayerA: boolean;
  myAnswers: MatchAnswer[];
}

const Q_SECTION = ["VARC", "VARC", "VARC", "DILR", "DILR", "DILR", "QUANT", "QUANT", "QUANT"] as const;
const SECTION_COLORS: Record<string, string> = {
  VARC: "text-[#118ab2]",
  DILR: "text-[#ffd166]",
  QUANT: "text-[#06d6a0]",
};

export default function ResultClient({ match, myProfile, oppProfile, isPlayerA, myAnswers }: Props) {
  const router = useRouter();
  const [showElo, setShowElo] = useState(false);
  const [rematchCode, setRematchCode] = useState<string | null>(null);
  const [creatingRematch, setCreatingRematch] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);

  const myScore = isPlayerA ? match.score_a : match.score_b;
  const oppScore = isPlayerA ? match.score_b : match.score_a;
  const myCorrect = isPlayerA ? match.correct_a : match.correct_b;
  const oppCorrect = isPlayerA ? match.correct_b : match.correct_a;
  const myEloBefore = isPlayerA ? match.elo_a_before : match.elo_b_before;
  const myEloAfter = isPlayerA ? match.elo_a_after : match.elo_b_after;
  const oppEloBefore = isPlayerA ? match.elo_b_before : match.elo_a_before;
  const oppEloAfter = isPlayerA ? match.elo_b_after : match.elo_a_after;

  const myDelta = myEloAfter != null && myEloBefore != null ? myEloAfter - myEloBefore : null;
  const oppDelta = oppEloAfter != null && oppEloBefore != null ? oppEloAfter - oppEloBefore : null;

  const isAbandoned = match.status === "abandoned";
  const iWon = match.winner_id === myProfile.id;
  const isDraw = match.winner_id === null && match.status === "completed";

  useEffect(() => {
    const timer = setTimeout(() => setShowElo(true), 800);
    return () => clearTimeout(timer);
  }, []);

  void router;

  async function handleEmailResult() {
    setSendingEmail(true);
    try {
      const res = await fetch("/api/email/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_id: match.id }),
      });
      if (!res.ok) throw new Error();
      setEmailSent(true);
    } catch {
      toast.error("Failed to send email");
    } finally {
      setSendingEmail(false);
    }
  }

  async function handleRematch() {
    setCreatingRematch(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: code, error } = await (supabase as any).rpc("create_challenge", { p_is_rated: match.is_rated });
    if (error || !code) {
      toast.error("Failed to create rematch");
      setCreatingRematch(false);
      return;
    }
    setRematchCode(code as string);
    setCreatingRematch(false);
  }

  async function handleCopyLink() {
    if (!rematchCode) return;
    const url = `${window.location.origin}/c/${rematchCode}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied!");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-start px-4 py-8">
      <div className="w-full max-w-md space-y-6">

        {/* Result banner */}
        <div className={cn(
          "rounded-2xl p-6 text-center border",
          isAbandoned
            ? "bg-[#7ab5cc]/10 border-[#7ab5cc]/30"
            : iWon ? "bg-[#06d6a0]/10 border-[#06d6a0]/30"
            : isDraw ? "bg-[#7ab5cc]/10 border-[#7ab5cc]/30"
            : "bg-[#ef476f]/10 border-[#ef476f]/30"
        )}>
          {isAbandoned ? (
            <><div className="text-4xl mb-2">🏃</div>
              <h1 className="text-[#c5e8f0] text-3xl font-bold text-balance">{iWon ? "Won by forfeit" : "Match abandoned"}</h1>
              <p className="text-[#7ab5cc] text-sm mt-1">Opponent disconnected</p></>
          ) : iWon ? (
            <><Trophy className="mx-auto mb-2 text-[#06d6a0]" size={36} />
              <h1 className="text-[#06d6a0] text-3xl font-bold text-balance">Victory!</h1>
              <p className="text-[#c5e8f0] text-sm mt-1">You won this match</p></>
          ) : isDraw ? (
            <><div className="text-4xl mb-2">🤝</div>
              <h1 className="text-[#c5e8f0] text-3xl font-bold text-balance">Draw</h1>
              <p className="text-[#7ab5cc] text-sm mt-1">Perfectly balanced</p></>
          ) : (
            <><div className="text-4xl mb-2">💀</div>
              <h1 className="text-[#ef476f] text-3xl font-bold text-balance">Defeat</h1>
              <p className="text-[#c5e8f0] text-sm mt-1">Better luck next time</p></>
          )}
        </div>

        {/* Score comparison */}
        <div className="bg-[#111111] rounded-xl p-5">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="space-y-2">
              <Avatar className="w-12 h-12 mx-auto">
                <AvatarImage src={myProfile.avatar_url ?? undefined} />
                <AvatarFallback className="bg-black text-[#06d6a0] font-bold">
                  {myProfile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <p className="text-white text-sm font-semibold truncate">{myProfile.display_name ?? myProfile.username}</p>
              <p className="text-[#ffd166] text-2xl font-bold">{myScore}</p>
              <p className="text-[#7ab5cc] text-xs">{myCorrect}/9 correct</p>
            </div>
            <div className="flex flex-col items-center justify-center gap-1">
              <span className="text-[#4a8fa8] font-bold text-xl">vs</span>
              <span className={match.is_rated ? "text-[#06d6a0]/70 text-xs" : "text-[#7ab5cc] text-xs"}>
                {match.is_rated ? "Rated" : "Unrated"}
              </span>
            </div>
            <div className="space-y-2">
              <Avatar className="w-12 h-12 mx-auto">
                <AvatarImage src={oppProfile.avatar_url ?? undefined} />
                <AvatarFallback className="bg-black text-[#c5e8f0] font-bold">
                  {oppProfile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <p className="text-white text-sm font-semibold truncate">{oppProfile.display_name ?? oppProfile.username}</p>
              <p className="text-white text-2xl font-bold">{oppScore}</p>
              <p className="text-[#7ab5cc] text-xs">{oppCorrect}/9 correct</p>
            </div>
          </div>
        </div>

        {/* ELO changes */}
        {match.is_rated && (
          <div className={cn(
            "bg-[#111111] rounded-xl p-5 motion-safe:transition-[opacity,transform] motion-safe:duration-500",
            showElo ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          )}>
            <h3 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-4">Rating change</h3>
            <div className="grid grid-cols-2 gap-6">
              <EloChange username={myProfile.display_name ?? myProfile.username} before={myEloBefore} after={myEloAfter} delta={myDelta} />
              <EloChange username={oppProfile.display_name ?? oppProfile.username} before={oppEloBefore} after={oppEloAfter} delta={oppDelta} />
            </div>
          </div>
        )}

        {/* Per-question breakdown by section */}
        <div className="bg-[#111111] rounded-xl p-5">
          <h3 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-4">Your answers</h3>
          {(["VARC", "DILR", "QUANT"] as const).map((sec) => {
            const indices = Q_SECTION.map((s, i) => (s === sec ? i : -1)).filter((i) => i >= 0);
            return (
              <div key={sec} className="mb-4 last:mb-0">
                <p className={cn("text-xs font-semibold mb-2", SECTION_COLORS[sec])}>{sec}</p>
                <div className="grid grid-cols-3 gap-2">
                  {indices.map((i) => {
                    const ans = myAnswers.find((a) => a.question_index === i);
                    if (!ans) return <AnswerDot key={i} status="unanswered" points={0} qNum={i + 1} />;
                    if (ans.is_correct) return <AnswerDot key={i} status="correct" points={ans.points_awarded} qNum={i + 1} />;
                    if (ans.selected_index === null) return <AnswerDot key={i} status="skipped" points={0} qNum={i + 1} />;
                    return <AnswerDot key={i} status="wrong" points={ans.points_awarded} qNum={i + 1} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Email results */}
        <button
          onClick={handleEmailResult}
          disabled={sendingEmail || emailSent}
          className="w-full flex items-center justify-center gap-2 text-[#7ab5cc] hover:text-white text-sm py-2 transition-colors disabled:opacity-50"
        >
          {emailSent ? <Check size={14} className="text-[#06d6a0]" /> : <Mail size={14} />}
          {emailSent ? "Result emailed!" : sendingEmail ? "Sending…" : "Email me these results"}
        </button>

        {/* Rematch */}
        {!rematchCode ? (
          <div className="grid grid-cols-2 gap-3">
            <Button
              onClick={handleRematch}
              disabled={creatingRematch}
              className="h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] flex items-center gap-1.5"
            >
              <RotateCcw size={14} />
              {creatingRematch ? "…" : "Rematch"}
            </Button>
            <Link href="/lobby">
              <Button variant="outline" className="w-full h-11 border-[#333333] text-white rounded-full hover:bg-[#111111] flex items-center gap-1.5">
                <Home size={14} />
                Home
              </Button>
            </Link>
          </div>
        ) : (
          <div className="bg-[#111111] rounded-xl p-4 space-y-3">
            <p className="text-[#c5e8f0] text-sm font-medium">Share this link with your opponent:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-black text-[#06d6a0] text-xs px-3 py-2 rounded-lg truncate">
                {typeof window !== "undefined"
                  ? `${window.location.origin}/c/${rematchCode}`
                  : `/c/${rematchCode}`}
              </code>
              <Button
                onClick={handleCopyLink}
                size="sm"
                className="shrink-0 bg-[#06d6a0] text-[#073b4c] hover:bg-[#05b088] rounded-lg px-3"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <Link href="/lobby">
              <Button variant="ghost" className="w-full text-[#7ab5cc] hover:text-white text-sm">
                Back to lobby
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function EloChange({ username, before, after, delta }: {
  username: string; before: number | null; after: number | null; delta: number | null;
}) {
  return (
    <div className="text-center">
      <p className="text-[#7ab5cc] text-xs truncate mb-1">{username}</p>
      <p className="text-white font-bold text-lg">{after ?? before ?? "—"}</p>
      {delta !== null && (
        <p className={cn("text-sm font-semibold elo-pop", delta > 0 ? "text-[#06d6a0]" : delta < 0 ? "text-[#ef476f]" : "text-[#7ab5cc]")}>
          {formatPoints(delta)}
        </p>
      )}
      {before !== null && <p className="text-[#4a8fa8] text-xs">from {before}</p>}
    </div>
  );
}

function AnswerDot({ status, points, qNum }: {
  status: "correct" | "wrong" | "skipped" | "unanswered"; points: number; qNum: number;
}) {
  return (
    <div className="flex flex-col items-center gap-1 bg-black rounded-lg py-2">
      <span className="text-[#4a8fa8] text-[9px]">Q{qNum}</span>
      <div className={cn(
        "w-6 h-6 rounded-full border flex items-center justify-center",
        status === "correct" ? "bg-[#06d6a0]/20 border-[#06d6a0]/50"
          : status === "wrong" ? "bg-[#ef476f]/20 border-[#ef476f]/50"
          : "bg-[#111111] border-[#333333]"
      )}>
        {status === "correct" && <span className="text-[#06d6a0] text-[9px]">✓</span>}
        {status === "wrong" && <span className="text-[#ef476f] text-[9px]">✗</span>}
      </div>
      <span className={cn("text-[9px] font-medium tabular-nums",
        points > 0 ? "text-[#06d6a0]" : points < 0 ? "text-[#ef476f]" : "text-[#4a8fa8]"
      )}>
        {points > 0 ? `+${points}` : points || "—"}
      </span>
    </div>
  );
}
