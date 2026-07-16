"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Loader2, Target, Home, RotateCcw, SkipForward } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NinjaPill } from "@/components/ninja-pill";
import { askNinja } from "@/lib/ninja";
import { NinjaLogo } from "@/components/ninja-logo";

// Solo practice drill. All keys stay server-side: get_practice_question serves
// body/options only; submit_practice_answer locks the answer and returns the
// reveal. State machine: idle → question → feedback → … → summary.
//
// Ninja is reachable only from the feedback phase — the server enforces the
// same rule (get_practice_question_for_ninja raises 'question not answered'),
// so the button's placement is convenience, not the guard.

type Question = {
  section: string;
  body: string;
  options: string[];
  image_url: string | null;
  passage_body: string | null;
  passage_image_url: string | null;
};

type Reveal = { is_correct: boolean; correct_index: number; explanation: string | null; done: boolean };

type PracticeState = {
  current_index: number;
  total: number;
  correct_count: number;
  completed: boolean;
  sections: string[];
  answers: { index: number; skipped: boolean; is_correct: boolean }[];
};

const SECTION_COLORS: Record<string, string> = {
  VARC: "text-[#118ab2]",
  DILR: "text-[#ffd166]",
  QUANT: "text-[#06d6a0]",
};

export default function PracticeClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createClient() as any;

  const [phase, setPhase] = useState<"idle" | "question" | "feedback" | "summary">("idle");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [total, setTotal] = useState(9);
  const [index, setIndex] = useState(0);
  const [question, setQuestion] = useState<Question | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [summary, setSummary] = useState<PracticeState | null>(null);

  async function loadQuestion(sid: string, i: number) {
    const { data, error } = await supabase.rpc("get_practice_question", { p_session: sid, p_index: i });
    if (error) throw new Error(error.message);
    const q = Array.isArray(data) ? data[0] : data;
    if (!q) throw new Error("question missing");
    setQuestion({ ...q, options: Array.isArray(q.options) ? q.options : [] });
    setSelected(null);
    setReveal(null);
    setIndex(i);
    setPhase("question");
  }

  async function start() {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("start_practice");
      if (error) {
        if (error.message.includes("daily practice limit")) {
          toast.error("Daily practice limit reached — come back tomorrow (or play matches!)");
        } else if (error.message.includes("no practice questions")) {
          toast.error("No practice questions available yet");
        } else {
          toast.error("Could not start practice: " + error.message);
        }
        return;
      }
      setSessionId(data.session_id);
      setTotal(data.total);
      await loadQuestion(data.session_id, 0);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(sel: number | null) {
    if (!sessionId) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("submit_practice_answer", {
        p_session: sessionId, p_index: index, p_selected: sel,
      });
      if (error) throw new Error(error.message);
      setSelected(sel);
      setReveal(data as Reveal);
      setPhase("feedback");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (!sessionId || !reveal) return;
    setBusy(true);
    try {
      if (reveal.done) {
        const { data, error } = await supabase.rpc("get_practice_state", { p_session: sessionId });
        if (error) throw new Error(error.message);
        setSummary(data as PracticeState);
        setPhase("summary");
      } else {
        await loadQuestion(sessionId, index + 1);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("idle");
    setSessionId(null);
    setQuestion(null);
    setSummary(null);
    setIndex(0);
  }

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-2xl space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-white font-semibold flex items-center gap-2">
            <Target size={18} className="text-[#06d6a0]" /> Practice
          </h1>
          <Link href="/lobby" className="text-[#7ab5cc] hover:text-white text-sm flex items-center gap-1.5">
            <Home size={14} /> Lobby
          </Link>
        </header>

        {phase === "idle" && (
          <div className="bg-[#111111] rounded-2xl p-8 text-center space-y-4">
            <Target size={40} className="mx-auto text-[#06d6a0]" />
            <h2 className="text-white text-xl font-bold">Targeted drill</h2>
            <p className="text-[#7ab5cc] text-sm max-w-sm mx-auto">
              9 questions weighted toward your weakest sections, picked near your rating.
              No timer, no ELO — instant explanations after every answer.
            </p>
            <Button onClick={start} disabled={busy}
              className="h-11 px-8 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088]">
              {busy ? <Loader2 className="animate-spin" size={16} /> : "Start practice"}
            </Button>
            <p className="text-[#4a8fa8] text-xs">Up to 5 sessions per day</p>
          </div>
        )}

        {(phase === "question" || phase === "feedback") && question && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs">
              <span className={cn("font-semibold", SECTION_COLORS[question.section] ?? "text-white")}>
                {question.section}
              </span>
              <span className="text-[#7ab5cc]">Question {index + 1} / {total}</span>
            </div>

            {question.passage_body && (
              <div className="bg-[#111111] rounded-xl p-4 max-h-64 overflow-y-auto">
                <p className="text-[#c5e8f0] text-sm whitespace-pre-line leading-relaxed">{question.passage_body}</p>
                {question.passage_image_url && (
                  <Image src={question.passage_image_url} alt="Passage diagram" width={640} height={360}
                    className="mt-3 rounded-lg max-w-full h-auto" unoptimized />
                )}
              </div>
            )}

            <div className="bg-[#111111] rounded-xl p-5 space-y-4">
              <p className="text-white text-base whitespace-pre-line">{question.body}</p>
              {question.image_url && (
                <Image src={question.image_url} alt="Question diagram" width={640} height={360}
                  className="rounded-lg max-w-full h-auto" unoptimized />
              )}

              <div className="space-y-2">
                {question.options.map((opt, i) => {
                  const isPicked = selected === i;
                  const isCorrect = reveal != null && i === reveal.correct_index;
                  const isWrongPick = reveal != null && isPicked && !isCorrect;
                  return (
                    <button
                      key={i}
                      disabled={phase === "feedback" || busy}
                      onClick={() => setSelected(i)}
                      className={cn(
                        "w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors",
                        isCorrect ? "border-[#06d6a0] bg-[#06d6a0]/10 text-[#06d6a0]"
                          : isWrongPick ? "border-[#ef476f] bg-[#ef476f]/10 text-[#ef476f]"
                          : isPicked ? "border-[#06d6a0]/60 bg-[#06d6a0]/5 text-white"
                          : "border-[#333333] text-[#c5e8f0] hover:border-[#4a8fa8]"
                      )}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>

              {phase === "question" && (
                <div className="flex gap-2">
                  <Button onClick={() => submit(selected)} disabled={busy || selected === null}
                    className="flex-1 h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088]">
                    {busy ? <Loader2 className="animate-spin" size={16} /> : "Submit"}
                  </Button>
                  <Button onClick={() => submit(null)} disabled={busy} variant="outline"
                    className="h-11 border-[#333333] text-[#7ab5cc] rounded-full hover:bg-[#111111] flex items-center gap-1.5">
                    <SkipForward size={14} /> Skip
                  </Button>
                </div>
              )}

              {phase === "feedback" && reveal && (
                <div className="space-y-3">
                  <div className={cn(
                    "rounded-lg px-4 py-3 text-sm font-semibold",
                    reveal.is_correct ? "bg-[#06d6a0]/10 text-[#06d6a0]" :
                    selected === null ? "bg-[#7ab5cc]/10 text-[#7ab5cc]" : "bg-[#ef476f]/10 text-[#ef476f]"
                  )}>
                    {reveal.is_correct ? "Correct!" : selected === null ? "Skipped" : "Wrong"}
                    {!reveal.is_correct && (
                      <span className="font-normal text-[#c5e8f0]">
                        {" — answer: "}{question.options[reveal.correct_index]}
                      </span>
                    )}
                  </div>
                  {reveal.explanation && (
                    <p className="text-[#c5e8f0] text-sm whitespace-pre-line leading-relaxed bg-[#120F17] rounded-lg px-4 py-3">
                      {reveal.explanation}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={next} disabled={busy}
                      className="flex-1 h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088]">
                      {busy ? <Loader2 className="animate-spin" size={16} /> : reveal.done ? "See summary" : "Next question"}
                    </Button>
                    <Button
                      onClick={() => sessionId && askNinja({
                        practiceSessionId: sessionId,
                        questionIndex: index,
                        label: `Q${index + 1} · ${question.section}`,
                      })}
                      disabled={busy || !sessionId}
                      variant="outline"
                      title="Ask Ninja to explain this question"
                      className="h-11 border-[#333333] text-[#7ab5cc] rounded-full hover:bg-[#120F17] flex items-center gap-1.5"
                    >
                      <NinjaLogo color="#06d6a0" className="w-4 h-4" /> Ask Ninja
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "summary" && summary && (
          <div className="bg-[#111111] rounded-2xl p-6 space-y-5">
            <div className="text-center">
              <p className="text-[#06d6a0] text-4xl font-bold">{summary.correct_count}/{summary.total}</p>
              <p className="text-[#7ab5cc] text-sm mt-1">correct this drill</p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["VARC", "DILR", "QUANT"] as const).map((sec) => {
                const idxs = summary.sections
                  .map((s, i) => (s === sec ? i : -1))
                  .filter((i) => i >= 0);
                if (idxs.length === 0) return null;
                const right = idxs.filter((i) => summary.answers.find((a) => a.index === i)?.is_correct).length;
                return (
                  <div key={sec} className="bg-[#120F17] rounded-lg px-3 py-2.5 text-center">
                    <p className={cn("text-xs font-semibold", SECTION_COLORS[sec])}>{sec}</p>
                    <p className="text-white text-lg font-bold">{right}/{idxs.length}</p>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <Button onClick={reset} disabled={busy}
                className="flex-1 h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] flex items-center gap-1.5">
                <RotateCcw size={14} /> Practice again
              </Button>
              <Link href="/lobby" className="flex-1">
                <Button variant="outline"
                  className="w-full h-11 border-[#333333] text-white rounded-full hover:bg-[#111111] flex items-center gap-1.5">
                  <Home size={14} /> Lobby
                </Button>
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Listens for the ninja:ask event fired from the feedback panel. */}
      <NinjaPill />
    </div>
  );
}
