"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Upload, Check } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import type { ExtractGroup } from "@/lib/ai/extract";

const SECTION_COLOR: Record<string, string> = { VARC: "#7ab5cc", DILR: "#ffd166", QUANT: "#06d6a0" };

// /ninja/solve — user-facing PDF solver. Upload a test/sample paper; Ninja
// extracts every question and shows the answer + worked explanation. Ephemeral:
// nothing is saved, nothing touches the question bank (that's the admin flow).
// Same extraction pipeline as the admin importer, via /api/ninja/solve.
export default function SolveClient() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<ExtractGroup[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const handleFile = useCallback(async (file: File) => {
    const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    if (!isPdf) { setError("Upload a PDF file."); return; }
    setError(null); setGroups(null); setWarnings([]); setFileName(file.name); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/ninja/solve", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const g = (data.groups ?? []) as ExtractGroup[];
      if (g.length === 0) throw new Error("No questions found in that PDF");
      setGroups(g);
      setWarnings((data.warnings ?? []) as string[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const total = groups?.reduce((n, g) => n + g.questions.length, 0) ?? 0;

  return (
    <div className="min-h-screen px-4 sm:pr-24 py-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <NinjaLogo color="#06d6a0" className="w-6 h-6" />
        <h1 className="text-white text-xl font-semibold">Solve a paper</h1>
      </div>
      <p className="text-[#7ab5cc] text-sm mb-6">
        Upload a test or sample paper (PDF). Ninja extracts every question and shows the answer with a worked explanation.
        <Link href="/ninja" className="text-[#06d6a0] hover:underline ml-2">← Ninja history</Link>
      </p>

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (busy) return; const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
        onClick={() => { if (!busy) fileRef.current?.click(); }}
        className={`rounded-xl border border-dashed p-10 text-center cursor-pointer transition-colors ${
          dragging ? "border-[#06d6a0] bg-[#06d6a0]/5" : "border-[#333333] hover:border-[#4a8fa8]"
        }`}
      >
        {busy
          ? <Loader2 className="mx-auto text-[#06d6a0] mb-2 animate-spin" size={26} />
          : <Upload className="mx-auto text-[#7ab5cc] mb-2" size={26} />}
        <p className="text-[#c5e8f0] text-sm">
          {busy ? <span className="text-white">Ninja is reading {fileName}… this can take a minute</span>
            : fileName && groups ? <span className="text-white">{fileName} — {total} question{total === 1 ? "" : "s"} solved</span>
            : "Drop a PDF, or click to pick"}
        </p>
        {!busy && !groups && <p className="text-[#7ab5cc] text-xs mt-1">Up to 60 pages · 20MB</p>}
        <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[#ef476f]/40 bg-[#ef476f]/10 px-4 py-3 text-[#ef476f] text-sm">{error}</div>
      )}
      {warnings.length > 0 && (
        <div className="mt-4 rounded-lg border border-[#ffd166]/40 bg-[#ffd166]/10 px-4 py-3 text-[#ffd166] text-xs space-y-0.5">
          <p className="font-semibold">Some pages couldn’t be read:</p>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {/* Solved paper */}
      {groups && (
        <div className="mt-6 space-y-4">
          {groups.map((g, gi) => (
            <div key={gi} className="rounded-xl bg-[#111111] overflow-hidden">
              {g.passage && (
                <div className="bg-[#1c1c1c] px-5 py-3">
                  <span className="text-[11px] font-bold" style={{ color: SECTION_COLOR[g.section] ?? "#7ab5cc" }}>{g.section}</span>
                  <p className="text-[#c5e8f0] text-sm mt-1 whitespace-pre-wrap leading-relaxed">{g.passage}</p>
                </div>
              )}
              <div className="divide-y divide-[#222222]">
                {g.questions.map((q, qi) => (
                  <SolvedQuestion key={qi} q={q} section={g.section} n={qi + 1} standalone={!g.passage} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SolvedQuestion({ q, section, n, standalone }: {
  q: ExtractGroup["questions"][number]; section: string; n: number; standalone: boolean;
}) {
  const raw = q.explanation ?? "";
  const needsDiagram = raw.startsWith("[NEEDS DIAGRAM]");
  const explanation = needsDiagram ? raw.replace("[NEEDS DIAGRAM]", "").trim() : raw;
  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-2">
        <span className="text-[#4a8fa8] text-xs mt-0.5 shrink-0">Q{n}</span>
        <div className="min-w-0 flex-1">
          {standalone && (
            <span className="text-[11px] font-bold mr-2" style={{ color: SECTION_COLOR[section] ?? "#7ab5cc" }}>{section}</span>
          )}
          <span className="text-white text-sm whitespace-pre-wrap">{q.body}</span>
          {needsDiagram && (
            <span className="ml-2 align-middle text-[10px] font-bold text-[#ffd166] border border-[#ffd166]/40 rounded px-1.5 py-0.5">
              NEEDS DIAGRAM
            </span>
          )}
          <div className="mt-2 space-y-1.5">
            {q.options.map((o, oi) => {
              const correct = oi === q.correct_index;
              return (
                <div key={oi} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm border ${
                  correct ? "bg-[#06d6a0]/10 border-[#06d6a0]/40 text-[#06d6a0]" : "bg-[#120F17] border-[#222222] text-[#c5e8f0]"
                }`}>
                  <span className="shrink-0 mt-0.5 w-4 text-center">
                    {correct ? <Check size={14} className="inline" /> : <span className="text-[#4a8fa8]">{String.fromCharCode(65 + oi)}</span>}
                  </span>
                  <span className="whitespace-pre-wrap">{o}</span>
                </div>
              );
            })}
          </div>
          {explanation && (
            <div className="mt-2 rounded-lg bg-[#120F17] px-3 py-2">
              <p className="text-[#7ab5cc] text-[11px] font-semibold uppercase tracking-wider mb-1">Explanation</p>
              <p className="text-[#c5e8f0] text-sm whitespace-pre-wrap leading-relaxed">{explanation}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
