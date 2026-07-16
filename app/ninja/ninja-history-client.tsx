"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, MessageSquare } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { createClient } from "@/lib/supabase/client";

interface Item {
  kind: "coach" | "debrief" | "response";
  question_index: number | null;
  question: string | null;
  content: string;
  created_at: string;
}
interface Session {
  match_id: string | null;
  opponent: string | null;
  result: "win" | "loss" | "draw" | null;
  played_at: string | null;
  last_at: string;
  items: Item[];
}

const RESULT_COLOR = { win: "#06d6a0", loss: "#ef476f", draw: "#ffd166" } as const;

function kindLabel(it: Item): string {
  if (it.kind === "coach") return "Coach chat";
  if (it.kind === "debrief") return "Match debrief";
  return `In-match hint · Q${(it.question_index ?? 0) + 1}`;
}

function sessionTitle(s: Session): string {
  if (!s.match_id) return "General chat";
  return s.opponent ? `vs ${s.opponent}` : "Match session";
}

// /ninja — browsable history of every Ninja AI output (coach chat, match
// debriefs, in-match hints), grouped into per-match sessions. Reuses the
// coach's dark card idiom; empty state fires the floating coach.
export default function NinjaHistoryClient() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_ninja_history").then(({ data }: { data: Session[] | null }) => {
      setSessions(Array.isArray(data) ? data : []);
    });
  }, []);

  if (sessions === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[#06d6a0]">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
        <NinjaLogo color="#06d6a0" className="w-12 h-12" />
        <p className="text-white text-lg font-semibold">No Ninja history yet</p>
        <p className="text-[#7ab5cc] text-sm max-w-sm">
          Ask Ninja about your stats, solve a paper, or generate a debrief after a match — everything shows up here.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/ninja/chat"
            className="rounded-full bg-[#06d6a0] px-5 py-2.5 text-[#073b4c] font-semibold hover:brightness-105 transition"
          >
            Start a chat
          </Link>
          <Link
            href="/ninja/solve"
            className="rounded-full border border-[#06d6a0]/50 px-5 py-2.5 text-[#06d6a0] font-semibold hover:bg-[#06d6a0]/10 transition"
          >
            Solve a paper
          </Link>
        </div>
      </div>
    );
  }

  const active = sessions[Math.min(selected, sessions.length - 1)];

  return (
    <div className="min-h-screen px-4 sm:pl-24 py-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <NinjaLogo color="#06d6a0" className="w-6 h-6" />
        <h1 className="text-white text-xl font-semibold">Ninja AI</h1>
        <Link
          href="/ninja/chat"
          className="ml-auto rounded-full bg-[#06d6a0] px-4 py-1.5 text-[#073b4c] text-sm font-semibold hover:brightness-105 transition"
        >
          New chat
        </Link>
        <Link
          href="/ninja/solve"
          className="rounded-full border border-[#06d6a0]/50 px-4 py-1.5 text-[#06d6a0] text-sm font-semibold hover:bg-[#06d6a0]/10 transition"
        >
          Solve a paper
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        {/* Sessions rail */}
        <div className="flex flex-col gap-1.5 max-h-[75vh] overflow-y-auto pr-1">
          {sessions.map((s, i) => {
            const on = i === selected;
            return (
              <button
                key={s.match_id ?? "general"}
                onClick={() => setSelected(i)}
                className={`text-left rounded-lg px-3 py-2.5 border transition ${
                  on ? "bg-[#111111] border-[#06d6a0]/50" : "bg-[#111111]/60 border-[#222222] hover:border-[#333333]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white text-sm font-medium truncate">{sessionTitle(s)}</span>
                  {s.result && (
                    <span className="text-[10px] font-bold uppercase" style={{ color: RESULT_COLOR[s.result] }}>
                      {s.result}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[#7ab5cc] text-xs">
                  <MessageSquare size={11} /> {s.items.length}
                  <span className="text-[#4a8fa8]">· {new Date(s.last_at).toLocaleDateString()}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Detail */}
        <div className="rounded-xl bg-[#111111] p-5 max-h-[75vh] overflow-y-auto">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="text-white text-sm font-semibold">{sessionTitle(active)}</h2>
            {active.match_id && (
              <Link href={`/result/${active.match_id}`} className="text-[#06d6a0] text-xs hover:underline shrink-0">
                View match →
              </Link>
            )}
          </div>

          <div className="space-y-5">
            {active.items.map((it, i) => (
              <div key={i} className="space-y-1.5">
                <p className="text-[#7ab5cc] text-[11px] font-medium uppercase tracking-wider">
                  {kindLabel(it)}
                  <span className="text-[#4a8fa8] normal-case tracking-normal ml-2">
                    {new Date(it.created_at).toLocaleString()}
                  </span>
                </p>
                {it.question && <p className="text-white text-sm font-medium">{it.question}</p>}
                <div className="rounded-lg bg-[#120F17] p-3">
                  <p className="text-[#c5e8f0] text-sm whitespace-pre-wrap leading-relaxed">{it.content}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
