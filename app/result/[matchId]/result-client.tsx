"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Trophy, RotateCcw, Home, Copy, Check, Mail, Target, Loader2, Flame } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { NinjaPill } from "@/components/ninja-pill";
import { NinjaDebrief } from "@/components/ninja-debrief";
import { askNinja } from "@/lib/ninja";
import type { Match, Profile, MatchAnswer } from "@/lib/supabase/types";
import { cn, formatPoints } from "@/lib/utils";
import { gsap, useGSAP, enterUp, stamp, countTo, prefersReduced, DUR, EASE } from "@/lib/motion";

interface Props {
  match: Match;
  myProfile: Profile;
  oppProfile: Profile;
  isPlayerA: boolean;
  myAnswers: MatchAnswer[];
}

export default function ResultClient({ match, myProfile, oppProfile, isPlayerA, myAnswers }: Props) {
  const router = useRouter();
  const [rematchCode, setRematchCode] = useState<string | null>(null);
  const [creatingRematch, setCreatingRematch] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [drilling, setDrilling] = useState(false);

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
  // Self-paced: I can reach my result before my opponent finishes. Until the
  // match finalizes there is no winner and the opponent's score is still moving,
  // so hold that state instead of showing a bogus outcome.
  const pending = match.status !== "completed" && match.status !== "abandoned";

  /* The payoff sequence: outcome stamps → cards rise → numbers roll (score
     count-up, ELO before→after) → answer dots pop → ELO delta and streak
     stamp last. Pending matches get the quiet version; when finalization
     arrives (pending flips), the whole verdict re-stamps. Presentation only —
     the realtime watcher below is untouched. */
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (prefersReduced()) return;
      const tl = gsap.timeline();
      tl.add(stamp("[data-anim='banner']"));
      tl.add(enterUp("[data-anim='card']", { stagger: 0.08 }), "-=0.15");
      if (pending) return;
      tl.addLabel("nums", "-=0.15");
      gsap.utils.toArray<HTMLElement>("[data-roll-to]").forEach((el) => {
        const to = parseInt(el.dataset.rollTo ?? "", 10);
        if (Number.isNaN(to)) return;
        const from = parseInt(el.dataset.rollFrom ?? "", 10);
        tl.add(countTo(el, Number.isNaN(from) ? 0 : from, to), "nums");
      });
      tl.add(
        gsap.from("[data-anim='dot']", {
          scale: 0.6,
          opacity: 0,
          duration: DUR.snap,
          ease: EASE.settle,
          stagger: 0.04,
          clearProps: "all",
        }),
        "nums+=0.1"
      );
      const deltas = gsap.utils.toArray<HTMLElement>("[data-anim='delta']");
      if (deltas.length) tl.add(stamp(deltas), "nums+=0.45");
      const flare = scope.current?.querySelector("[data-anim='streak']");
      if (flare) tl.add(stamp(flare), "nums+=0.6");
    },
    { scope, dependencies: [pending], revertOnUpdate: true }
  );

  // While pending, watch for finalization and pull the decided result in.
  useEffect(() => {
    if (!pending) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`result:${match.id}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${match.id}`,
      }, (payload) => {
        const s = (payload.new as Match).status;
        if (s === "completed" || s === "abandoned") router.refresh();
      })
      .subscribe();
    // Fallback poll in case the socket misses the update.
    const poll = setInterval(() => router.refresh(), 15_000);
    return () => { clearInterval(poll); supabase.removeChannel(channel); };
  }, [pending, match.id, router]);

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

  // Build a practice drill from this match's misses (server picks similar
  // bank questions via embeddings; falls back to same-section difficulty).
  async function handleDrillSimilar() {
    setDrilling(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("start_practice_similar", { p_match_id: match.id });
    if (error || !data?.session_id) {
      toast.error(
        error?.message?.includes("daily practice limit")
          ? "Daily practice limit reached — come back tomorrow"
          : "Could not build a drill right now"
      );
      setDrilling(false);
      return;
    }
    router.push(`/practice?session=${data.session_id}`);
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
    <div ref={scope} className="min-h-screen bg-[#120F17] flex flex-col items-center justify-start px-4 py-8">
      <div className="w-full max-w-md space-y-6">

        {/* Result banner */}
        <div data-anim="banner" className={cn(
          "rounded-2xl p-6 text-center border",
          pending
            ? "bg-[#ffd166]/10 border-[#ffd166]/30"
            : isAbandoned
            ? "bg-[#7ab5cc]/10 border-[#7ab5cc]/30"
            : iWon ? "bg-[#06d6a0]/10 border-[#06d6a0]/30"
            : isDraw ? "bg-[#7ab5cc]/10 border-[#7ab5cc]/30"
            : "bg-[#ef476f]/10 border-[#ef476f]/30"
        )}>
          {pending ? (
            <><div className="text-4xl mb-2">🏁</div>
              <h1 className="text-[#ffd166] text-3xl font-bold text-balance">You finished!</h1>
              <p className="text-[#c5e8f0] text-sm mt-1">Opponent still answering — the winner is decided once they finish. You can leave; the result will be here (and on your profile) when it&apos;s ready.</p></>
          ) : isAbandoned ? (
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
          {/* Streak flare — stamps in last on a decided win */}
          {!pending && !isAbandoned && iWon && myProfile.current_streak >= 2 && (
            <div data-anim="streak" className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#ffd166]/10 border border-[#ffd166]/30 px-3 py-1">
              <Flame size={12} className="text-[#ffd166]" />
              <span className="text-[#ffd166] text-xs font-semibold">{myProfile.current_streak} win streak</span>
            </div>
          )}
        </div>

        {/* Score comparison */}
        <div data-anim="card" className="bg-[#111111] rounded-xl p-5">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="space-y-2">
              <Avatar className="w-12 h-12 mx-auto">
                <AvatarImage src={myProfile.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#120F17] text-[#06d6a0] font-bold">
                  {myProfile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <p className="text-white text-sm font-semibold truncate">{myProfile.display_name ?? myProfile.username}</p>
              <p data-roll-to={myScore} className="text-[#ffd166] text-2xl font-bold tabular-nums">{myScore}</p>
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
                <AvatarFallback className="bg-[#120F17] text-[#c5e8f0] font-bold">
                  {oppProfile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <p className="text-white text-sm font-semibold truncate">{oppProfile.display_name ?? oppProfile.username}</p>
              {pending ? (
                <><p className="text-[#7ab5cc] text-2xl font-bold">·&thinsp;·&thinsp;·</p>
                  <p className="text-[#7ab5cc] text-xs">still answering</p></>
              ) : (
                <><p data-roll-to={oppScore} className="text-white text-2xl font-bold tabular-nums">{oppScore}</p>
                  <p className="text-[#7ab5cc] text-xs">{oppCorrect}/9 correct</p></>
              )}
            </div>
          </div>
        </div>

        {/* ELO changes — only once the match is finalized (no rating until then) */}
        {match.is_rated && !pending && (
          <div data-anim="card" className="bg-[#111111] rounded-xl p-5">
            <h3 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-4">Rating change</h3>
            <div className="grid grid-cols-2 gap-6">
              <EloChange username={myProfile.display_name ?? myProfile.username} before={myEloBefore} after={myEloAfter} delta={myDelta} />
              <EloChange username={oppProfile.display_name ?? oppProfile.username} before={oppEloBefore} after={oppEloAfter} delta={oppDelta} />
            </div>
          </div>
        )}

        {/* Per-question breakdown. Flat 9-grid — the section mix is content-driven
            now (quant-only today), so no fixed 3-3-3 grouping. */}
        <div data-anim="card" className="bg-[#111111] rounded-xl p-5">
          <h3 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-4">Your answers</h3>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 9 }).map((_, i) => {
              const onAsk = () => askNinja({ matchId: match.id, questionIndex: i, label: `Q${i + 1}` });
              const ans = myAnswers.find((a) => a.question_index === i);
              if (!ans) return <AnswerDot key={i} status="unanswered" points={0} qNum={i + 1} onAsk={onAsk} />;
              if (ans.is_correct) return <AnswerDot key={i} status="correct" points={ans.points_awarded} qNum={i + 1} onAsk={onAsk} />;
              // A skip is BOTH nulls. TITA answers are typed into answer_text and
              // leave selected_index null, so checking selected_index alone
              // rendered every wrong TITA as "skipped" — with negative points.
              if (ans.selected_index === null && ans.answer_text === null) {
                return <AnswerDot key={i} status="skipped" points={0} qNum={i + 1} onAsk={onAsk} />;
              }
              return <AnswerDot key={i} status="wrong" points={ans.points_awarded} qNum={i + 1} onAsk={onAsk} />;
            })}
          </div>
          {!pending && myAnswers.some((a) => !a.is_correct) && (
            <Button
              onClick={handleDrillSimilar}
              disabled={drilling}
              variant="outline"
              className="w-full h-10 mt-4 border-[#333333] text-[#7ab5cc] rounded-full hover:bg-[#120F17] hover:text-white flex items-center gap-1.5"
            >
              {drilling ? <Loader2 className="animate-spin" size={14} /> : <Target size={14} className="text-[#06d6a0]" />}
              Drill questions like your misses
            </Button>
          )}
        </div>

        {/* Ninja debrief + email — only once the match is finalized (the debrief
            RPC needs a finished match, and the email would send a partial result). */}
        {!pending && (
          <div data-anim="card">
            <NinjaDebrief matchId={match.id} />
          </div>
        )}

        {!pending && (
          <button
            data-anim="card"
            onClick={handleEmailResult}
            disabled={sendingEmail || emailSent}
            className="w-full flex items-center justify-center gap-2 text-[#7ab5cc] hover:text-white text-sm py-2 transition-colors disabled:opacity-50"
          >
            {emailSent ? <Check size={14} className="text-[#06d6a0]" /> : <Mail size={14} />}
            {emailSent ? "Result emailed!" : sendingEmail ? "Sending…" : "Email me these results"}
          </button>
        )}

        {/* Rematch */}
        {!rematchCode ? (
          <div data-anim="card" className="grid grid-cols-2 gap-3">
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
              <code className="flex-1 bg-[#120F17] text-[#06d6a0] text-xs px-3 py-2 rounded-lg truncate">
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
      <NinjaPill />
    </div>
  );
}

function EloChange({ username, before, after, delta }: {
  username: string; before: number | null; after: number | null; delta: number | null;
}) {
  return (
    <div className="text-center">
      <p className="text-[#7ab5cc] text-xs truncate mb-1">{username}</p>
      <p
        data-roll-to={after ?? undefined}
        data-roll-from={before ?? undefined}
        className="text-white font-bold text-lg tabular-nums"
      >{after ?? before ?? "—"}</p>
      {delta !== null && (
        <p className={cn("inline-block text-sm font-semibold", delta > 0 ? "text-[#06d6a0]" : delta < 0 ? "text-[#ef476f]" : "text-[#7ab5cc]")} data-anim="delta">
          {formatPoints(delta)}
        </p>
      )}
      {before !== null && <p className="text-[#4a8fa8] text-xs">from {before}</p>}
    </div>
  );
}

function AnswerDot({ status, points, qNum, onAsk }: {
  status: "correct" | "wrong" | "skipped" | "unanswered"; points: number; qNum: number; onAsk: () => void;
}) {
  return (
    <button
      data-anim="dot"
      onClick={onAsk}
      title="Ask Ninja to attempt this question"
      className="flex flex-col items-center gap-1 bg-[#120F17] rounded-lg py-2 w-full hover:bg-[#1a1622] transition-colors cursor-pointer"
    >
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
    </button>
  );
}
