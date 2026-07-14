"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Upload, FileJson, FileSpreadsheet, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  parseCsv,
  parseJson,
  flattenQuestions,
  type GroupInput,
  type SectionCode,
} from "./parse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any; // RPCs below aren't in generated types yet (migration pending).

type UpsertResult = { inserted: number; updated: number; errors: { row: number; reason: string }[] };

type ListRow = {
  id: string;
  section: SectionCode;
  body: string;
  options: string[];
  correct_index: number;
  difficulty: number | null;
  explanation: string | null;
  is_active: boolean;
  passage_id: string | null;
  passage_body: string | null;
  passage_is_active: boolean | null;
  created_at: string;
};

const SECTIONS: SectionCode[] = ["VARC", "DILR", "QUANT"];

// ---- Download templates (must match parse.ts exactly) ----------------------

const JSON_TEMPLATE = JSON.stringify(
  [
    {
      section: "VARC",
      passage: "Read the following passage and answer the questions that follow. …",
      questions: [
        { body: "What is the main idea of the passage?", options: ["A", "B", "C", "D"], correct_index: 0, difficulty: 2, explanation: "See paragraph 1." },
        { body: "The author's tone is best described as?", options: ["A", "B", "C", "D"], correct_index: 1 },
        { body: "Which inference is best supported?", options: ["A", "B", "C", "D"], correct_index: 2 },
      ],
    },
    {
      section: "DILR",
      passage: "The chart shows sales by quarter.",
      passage_image_url: "https://<project>.supabase.co/storage/v1/object/public/question-assets/chart.png",
      questions: [
        { body: "Which quarter had the highest sales?", options: ["Q1", "Q2", "Q3", "Q4"], correct_index: 3 },
      ],
    },
    {
      section: "QUANT",
      passage: null,
      questions: [
        { body: "In the figure, find angle x.", options: ["30", "45", "60", "90"], correct_index: 1, duration_ms: 90000, image_url: "https://<project>.supabase.co/storage/v1/object/public/question-assets/angle.png" },
      ],
    },
  ],
  null,
  2
);

const CSV_TEMPLATE = [
  "section,passage_group,passage_body,passage_image_url,body,options,correct_index,difficulty,explanation,duration_ms,image_url",
  'VARC,p1,"Read the following passage and answer the questions that follow. …",,"What is the main idea of the passage?","A|B|C|D",0,2,"See paragraph 1.",,',
  'VARC,p1,,,"The author\'s tone is best described as?","A|B|C|D",1,,,,',
  'VARC,p1,,,"Which inference is best supported?","A|B|C|D",2,,,,',
  'QUANT,,,,"If x + 3 = 7, then x = ?","2|3|4|5",2,,,90000,',
].join("\n");

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Shared groups preview (upload + AI generate) ---------------------------

function GroupsPreview({ groups, errorRows }: { groups: GroupInput[]; errorRows: Map<number, string> }) {
  const flat = flattenQuestions(groups);
  return (
    <div className="rounded-lg border border-[#222222] overflow-hidden divide-y divide-[#222222]">
      {groups.map((g, gi) => {
        const rowsBefore = flat.filter((f) => f.groupIndex < gi).length;
        return (
          <div key={gi}>
            {g.passage ? (
              <div className="bg-[#1c1c1c] px-4 py-2">
                <span className="text-[#06d6a0] text-[11px] font-semibold mr-2">{g.section}</span>
                <span className="text-[#c5e8f0] text-xs">{snippet(g.passage, 140)}</span>
              </div>
            ) : null}
            {g.questions.map((q, qi) => {
              const rowNo = rowsBefore + qi + 1; // 1-based flat index
              const err = errorRows.get(rowNo);
              return (
                <div key={qi} className={`px-4 py-2.5 ${g.passage ? "pl-8" : ""} ${err ? "bg-[#ef476f]/10" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className="text-[#4a8fa8] text-[11px] mt-0.5 w-8 shrink-0">#{rowNo}</span>
                    <div className="min-w-0 flex-1">
                      {!g.passage && <span className="text-[#06d6a0] text-[11px] font-semibold mr-2">{g.section}</span>}
                      <span className="text-white text-sm">{snippet(q.body, 120)}</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {q.options.map((o, oi) => (
                          <span
                            key={oi}
                            className={`text-[11px] px-1.5 py-0.5 rounded ${
                              oi === q.correct_index
                                ? "bg-[#06d6a0]/15 text-[#06d6a0] border border-[#06d6a0]/40"
                                : "bg-[#120F17] text-[#7ab5cc] border border-[#222222]"
                            }`}
                          >
                            {snippet(o, 40)}
                          </span>
                        ))}
                      </div>
                      {q.explanation && (
                        <p className="text-[#7ab5cc] text-[11px] mt-1">{snippet(q.explanation, 160)}</p>
                      )}
                      {err && <p className="text-[#ef476f] text-[11px] mt-1">Error: {err}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---- Upload panel ----------------------------------------------------------

function UploadPanel({ onUpserted }: { onUpserted: () => void }) {
  const supabase = createClient() as AnyClient;
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupInput[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpsertResult | null>(null);

  const flat = useMemo(() => (groups ? flattenQuestions(groups) : []), [groups]);
  const errorRows = useMemo(() => {
    const m = new Map<number, string>();
    result?.errors.forEach((e) => m.set(e.row, e.reason));
    return m; // key = 1-based flat row
  }, [result]);

  const handleFile = useCallback(async (file: File) => {
    setResult(null);
    setParseError(null);
    setGroups(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const isCsv = file.name.toLowerCase().endsWith(".csv");
      const parsed = isCsv ? parseCsv(text) : parseJson(text);
      if (parsed.length === 0) throw new Error("No questions found in file");
      setGroups(parsed);
    } catch (e) {
      setParseError((e as Error).message);
      setFileName(file.name);
    }
  }, []);

  async function submit() {
    if (!groups) return;
    setSubmitting(true);
    setResult(null);
    const { data, error } = await supabase.rpc("admin_upsert_questions", { payload: groups });
    setSubmitting(false);
    if (error) {
      toast.error("Upload failed: " + error.message);
      return;
    }
    const res = data as UpsertResult;
    setResult(res);
    if (res.errors.length === 0) {
      toast.success(`${res.inserted} inserted, ${res.updated} updated`);
      setGroups(null);
      setFileName(null);
    } else {
      toast.warning(`Partial: ${res.inserted} inserted, ${res.updated} updated, ${res.errors.length} failed`);
    }
    onUpserted();
  }

  const totalQuestions = flat.length;

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-[#7ab5cc] text-sm font-medium">Upload questions</h2>
        <div className="flex gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => download("questions-template.json", JSON_TEMPLATE, "application/json")}
            className="border-[#333333] text-[#c5e8f0] hover:text-white hover:bg-[#1c1c1c] flex items-center gap-1.5"
          >
            <FileJson size={14} /> Template .json
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => download("questions-template.csv", CSV_TEMPLATE, "text/csv")}
            className="border-[#333333] text-[#c5e8f0] hover:text-white hover:bg-[#1c1c1c] flex items-center gap-1.5"
          >
            <FileSpreadsheet size={14} /> Template .csv
          </Button>
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        onClick={() => fileRef.current?.click()}
        className={`rounded-lg border border-dashed p-8 text-center cursor-pointer transition-colors ${
          dragging ? "border-[#06d6a0] bg-[#06d6a0]/5" : "border-[#333333] hover:border-[#4a8fa8]"
        }`}
      >
        <Upload className="mx-auto text-[#7ab5cc] mb-2" size={22} />
        <p className="text-[#c5e8f0] text-sm">
          {fileName ? <span className="text-white">{fileName}</span> : "Drop a .json or .csv file, or click to pick"}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
        />
      </div>

      {parseError && (
        <div className="rounded-lg border border-[#ef476f]/40 bg-[#ef476f]/10 px-4 py-3 text-[#ef476f] text-sm">
          {parseError}
        </div>
      )}

      {/* Preview */}
      {groups && (
        <div className="space-y-3">
          <p className="text-[#7ab5cc] text-xs">
            Preview: <span className="text-white">{groups.length}</span> group{groups.length === 1 ? "" : "s"},{" "}
            <span className="text-white">{totalQuestions}</span> question{totalQuestions === 1 ? "" : "s"}
          </p>

          <GroupsPreview groups={groups} errorRows={errorRows} />

          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-[#06d6a0] text-[#073b4c] font-semibold rounded-lg hover:bg-[#05b088] flex items-center gap-1.5"
          >
            {submitting ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
            {submitting ? "Uploading…" : `Upload ${totalQuestions} question${totalQuestions === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}

      {/* Result summary */}
      {result && (
        <div className="rounded-lg border border-[#222222] bg-[#120F17] px-4 py-3 space-y-1.5">
          <p className="text-sm">
            <span className="text-[#06d6a0] font-semibold">{result.inserted} inserted</span>
            <span className="text-[#7ab5cc]">, </span>
            <span className="text-[#06d6a0] font-semibold">{result.updated} updated</span>
            {result.errors.length > 0 && (
              <span className="text-[#ef476f] font-semibold">, {result.errors.length} failed</span>
            )}
          </p>
          {result.errors.length > 0 && (
            <ul className="text-[#ef476f] text-xs space-y-0.5">
              {result.errors.map((e, i) => (
                <li key={i}>Row #{e.row}: {e.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---- AI generate panel -------------------------------------------------------

function GeneratePanel({ onUpserted }: { onUpserted: () => void }) {
  const supabase = createClient() as AnyClient;
  const [section, setSection] = useState<SectionCode>("QUANT");
  const [kind, setKind] = useState<"standalone" | "passage">("standalone");
  const [count, setCount] = useState(3);
  const [difficulty, setDifficulty] = useState(3);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [groups, setGroups] = useState<GroupInput[] | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpsertResult | null>(null);

  const errorRows = useMemo(() => {
    const m = new Map<number, string>();
    result?.errors.forEach((e) => m.set(e.row, e.reason));
    return m;
  }, [result]);

  async function generate() {
    setGenerating(true);
    setResult(null);
    try {
      const res = await fetch("/api/ninja/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, kind, count, difficulty, topic: topic || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setGroups(data.groups as GroupInput[]);
      setModelUsed(data.model_id ?? null);
    } catch (e) {
      toast.error("Generation failed: " + (e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function submit() {
    if (!groups) return;
    setSubmitting(true);
    setResult(null);
    const { data, error } = await supabase.rpc("admin_upsert_questions", { payload: groups });
    setSubmitting(false);
    if (error) {
      toast.error("Upload failed: " + error.message);
      return;
    }
    const res = data as UpsertResult;
    setResult(res);
    if (res.errors.length === 0) {
      toast.success(`${res.inserted} AI question${res.inserted === 1 ? "" : "s"} added to bank`);
      setGroups(null);
    } else {
      toast.warning(`Partial: ${res.inserted} inserted, ${res.errors.length} failed`);
    }
    onUpserted();
  }

  const total = groups ? flattenQuestions(groups).length : 0;
  const input = "bg-[#120F17] border border-[#333333] text-[#c5e8f0] text-sm rounded-lg px-2.5 py-1.5 focus:border-[#06d6a0] outline-none";

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <h2 className="text-[#7ab5cc] text-sm font-medium flex items-center gap-1.5">
        <Sparkles size={14} className="text-[#06d6a0]" /> Generate questions with Ninja
      </h2>

      <div className="flex flex-wrap gap-2 items-center">
        <select value={section} className={input}
          onChange={(e) => {
            const s = e.target.value as SectionCode;
            setSection(s);
            if (s === "QUANT") setKind("standalone"); // QUANT is standalone-only in the picker
          }}>
          {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as "standalone" | "passage")}
          className={input} disabled={section === "QUANT"}>
          <option value="standalone">Standalone</option>
          <option value="passage">{section === "DILR" ? "Data set + questions" : "Passage + questions"}</option>
        </select>
        <label className="text-[#7ab5cc] text-xs flex items-center gap-1.5">
          Count
          <input type="number" min={1} max={10} value={count}
            onChange={(e) => setCount(Math.min(Math.max(Number(e.target.value) || 1, 1), 10))}
            className={input + " w-16"} />
        </label>
        <label className="text-[#7ab5cc] text-xs flex items-center gap-1.5">
          Difficulty
          <input type="number" min={1} max={5} value={difficulty}
            onChange={(e) => setDifficulty(Math.min(Math.max(Number(e.target.value) || 3, 1), 5))}
            className={input + " w-16"} />
        </label>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional), e.g. time & work"
          className={input + " flex-1 min-w-[180px]"} maxLength={200} />
      </div>

      <div className="flex gap-2">
        <Button onClick={generate} disabled={generating}
          className="bg-[#06d6a0] text-[#073b4c] font-semibold rounded-lg hover:bg-[#05b088] flex items-center gap-1.5">
          {generating ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
          {generating ? "Generating…" : groups ? "Regenerate" : "Generate"}
        </Button>
        {groups && (
          <Button onClick={submit} disabled={submitting} variant="outline"
            className="border-[#06d6a0]/40 text-[#06d6a0] rounded-lg hover:bg-[#06d6a0]/10 flex items-center gap-1.5">
            {submitting ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
            {submitting ? "Adding…" : `Add ${total} to bank`}
          </Button>
        )}
      </div>

      {groups && (
        <div className="space-y-2">
          <p className="text-[#7ab5cc] text-xs">
            Draft: <span className="text-white">{total}</span> question{total === 1 ? "" : "s"}
            {modelUsed && <span className="text-[#4a8fa8]"> · {modelUsed}</span>}
            <span className="text-[#ffd166]"> · review before adding — AI drafts can be wrong</span>
          </p>
          <GroupsPreview groups={groups} errorRows={errorRows} />
        </div>
      )}

      {result && result.errors.length > 0 && (
        <ul className="text-[#ef476f] text-xs space-y-0.5">
          {result.errors.map((e, i) => <li key={i}>Row #{e.row}: {e.reason}</li>)}
        </ul>
      )}
    </section>
  );
}

// ---- Content list ----------------------------------------------------------

function snippet(s: string, n: number) {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

type SectionStat = { standaloneActive: number; passagesWith3: number; starved: boolean };

function computeStats(rows: ListRow[]): Record<SectionCode, SectionStat> {
  const out = {} as Record<SectionCode, SectionStat>;
  for (const sec of SECTIONS) {
    const secRows = rows.filter((r) => r.section === sec);
    const standaloneActive = secRows.filter((r) => !r.passage_id && r.is_active).length;
    // active sub-questions per active passage
    const perPassage = new Map<string, number>();
    for (const r of secRows) {
      if (r.passage_id && r.is_active && r.passage_is_active) {
        perPassage.set(r.passage_id, (perPassage.get(r.passage_id) ?? 0) + 1);
      }
    }
    const passagesWith3 = [...perPassage.values()].filter((c) => c >= 3).length;
    // QUANT needs 3 standalone; VARC/DILR need a passage-with-≥3 OR 3 standalone.
    const ok = sec === "QUANT" ? standaloneActive >= 3 : passagesWith3 >= 1 || standaloneActive >= 3;
    out[sec] = { standaloneActive, passagesWith3, starved: !ok };
  }
  return out;
}

type DistractorProposal = {
  options: string[];
  correct_index: number;
  explanation: string | null;
  rationale: string | null;
};

function ContentList({ reloadKey }: { reloadKey: number }) {
  const supabase = createClient() as AnyClient;
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<"ALL" | SectionCode>("ALL");
  const [active, setActive] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [proposals, setProposals] = useState<Record<string, DistractorProposal>>({});
  const [improvingId, setImprovingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // Note: no synchronous setLoading(true) here — it would trip
  // react-hooks/set-state-in-effect. Initial useState(true) covers first paint.
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_list_questions", {
      p_section: section === "ALL" ? null : section,
      p_active: active === "ALL" ? null : active === "ACTIVE",
    });
    if (error) toast.error("Failed to load: " + error.message);
    setRows((data as ListRow[]) ?? []);
    setLoading(false);
  }, [supabase, section, active]);

  // ponytail: standard data-fetch-on-mount effect (same idiom as match/profile clients).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load, reloadKey]);

  const stats = useMemo(() => computeStats(rows), [rows]);

  async function toggleQuestion(r: ListRow) {
    const next = !r.is_active;
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, is_active: next } : x))); // optimistic
    const { error } = await supabase.rpc("admin_set_question_active", { p_id: r.id, p_active: next });
    if (error) {
      toast.error("Toggle failed: " + error.message);
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, is_active: !next } : x)));
    }
  }

  async function improveOptions(r: ListRow) {
    setImprovingId(r.id);
    try {
      const res = await fetch("/api/ninja/distractors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: r.section,
          body: r.body,
          options: r.options,
          correct_index: r.correct_index,
          explanation: r.explanation,
          passage_body: r.passage_body,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setProposals((p) => ({ ...p, [r.id]: data as DistractorProposal }));
    } catch (e) {
      toast.error("Distractor generation failed: " + (e as Error).message);
    } finally {
      setImprovingId(null);
    }
  }

  async function applyProposal(r: ListRow) {
    const p = proposals[r.id];
    if (!p) return;
    setApplyingId(r.id);
    const { error } = await supabase.rpc("admin_update_question_options", {
      p_id: r.id,
      p_options: p.options,
      p_correct_index: p.correct_index,
      p_explanation: p.explanation,
    });
    setApplyingId(null);
    if (error) {
      toast.error("Apply failed: " + error.message);
      return;
    }
    toast.success("Options updated");
    setRows((prev) => prev.map((x) => (x.id === r.id
      ? { ...x, options: p.options, correct_index: p.correct_index, explanation: p.explanation ?? x.explanation }
      : x)));
    dismissProposal(r.id);
  }

  function dismissProposal(id: string) {
    setProposals((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function togglePassage(passageId: string, next: boolean) {
    setRows((prev) => prev.map((x) => (x.passage_id === passageId ? { ...x, passage_is_active: next } : x)));
    const { error } = await supabase.rpc("admin_set_passage_active", { p_id: passageId, p_active: next });
    if (error) {
      toast.error("Toggle failed: " + error.message);
      setRows((prev) => prev.map((x) => (x.passage_id === passageId ? { ...x, passage_is_active: !next } : x)));
    }
  }

  // Group rows: passages together (in first-seen order), standalone separately.
  const grouped = useMemo(() => {
    const passages = new Map<string, ListRow[]>();
    const standalone: ListRow[] = [];
    for (const r of rows) {
      if (r.passage_id) {
        const arr = passages.get(r.passage_id) ?? [];
        arr.push(r);
        passages.set(r.passage_id, arr);
      } else standalone.push(r);
    }
    return { passages, standalone };
  }, [rows]);

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-[#7ab5cc] text-sm font-medium">Question bank</h2>
        <div className="flex gap-2">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as "ALL" | SectionCode)}
            className="bg-[#120F17] border border-[#333333] text-[#c5e8f0] text-sm rounded-lg px-2.5 py-1.5 focus:border-[#06d6a0] outline-none"
          >
            <option value="ALL">All sections</option>
            {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={active}
            onChange={(e) => setActive(e.target.value as "ALL" | "ACTIVE" | "INACTIVE")}
            className="bg-[#120F17] border border-[#333333] text-[#c5e8f0] text-sm rounded-lg px-2.5 py-1.5 focus:border-[#06d6a0] outline-none"
          >
            <option value="ALL">All</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>
      </div>

      {/* Per-section stats / starvation flags */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {SECTIONS.map((s) => {
          const st = stats[s];
          return (
            <div
              key={s}
              className={`rounded-lg border px-3 py-2 ${
                st.starved ? "border-[#ffd166]/50 bg-[#ffd166]/10" : "border-[#222222] bg-[#120F17]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-white text-xs font-semibold">{s}</span>
                {st.starved && <span className="text-[#ffd166] text-[10px] font-semibold">STARVED</span>}
              </div>
              <p className="text-[#7ab5cc] text-[11px] mt-0.5">{st.standaloneActive} standalone active</p>
              <p className="text-[#7ab5cc] text-[11px]">{st.passagesWith3} passage{st.passagesWith3 === 1 ? "" : "s"} with ≥3 active</p>
            </div>
          );
        })}
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="text-[#06d6a0] animate-spin" size={20} /></div>
      ) : rows.length === 0 ? (
        <p className="text-[#4a8fa8] text-sm py-6 text-center">No questions match the filter.</p>
      ) : (
        <div className="rounded-lg border border-[#222222] overflow-hidden divide-y divide-[#222222]">
          {/* Passage groups */}
          {[...grouped.passages.entries()].map(([pid, qs]) => {
            const pActive = qs[0].passage_is_active ?? true;
            return (
              <div key={pid}>
                <div className="bg-[#1c1c1c] px-4 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[#06d6a0] text-[11px] font-semibold mr-2">{qs[0].section}</span>
                    <span className="text-[#c5e8f0] text-xs">{snippet(qs[0].passage_body ?? "(passage)", 120)}</span>
                    <span className="text-[#4a8fa8] text-[11px] ml-2">· {qs.length} Q</span>
                  </div>
                  <button
                    onClick={() => togglePassage(pid, !pActive)}
                    className={`shrink-0 text-[11px] px-2 py-1 rounded border ${
                      pActive
                        ? "border-[#06d6a0]/40 text-[#06d6a0]"
                        : "border-[#333333] text-[#7ab5cc]"
                    }`}
                  >
                    {pActive ? "Active" : "Inactive"}
                  </button>
                </div>
                {qs.map((r) => (
                  <QuestionRow key={r.id} r={r} indent onToggle={() => toggleQuestion(r)}
                    onImprove={() => improveOptions(r)} improving={improvingId === r.id}
                    proposal={proposals[r.id]} onApply={() => applyProposal(r)}
                    onDismiss={() => dismissProposal(r.id)} applying={applyingId === r.id} />
                ))}
              </div>
            );
          })}
          {/* Standalone questions */}
          {grouped.standalone.map((r) => (
            <QuestionRow key={r.id} r={r} onToggle={() => toggleQuestion(r)}
              onImprove={() => improveOptions(r)} improving={improvingId === r.id}
              proposal={proposals[r.id]} onApply={() => applyProposal(r)}
              onDismiss={() => dismissProposal(r.id)} applying={applyingId === r.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function QuestionRow({ r, indent, onToggle, onImprove, improving, proposal, onApply, onDismiss, applying }: {
  r: ListRow;
  indent?: boolean;
  onToggle: () => void;
  onImprove: () => void;
  improving: boolean;
  proposal?: DistractorProposal;
  onApply: () => void;
  onDismiss: () => void;
  applying: boolean;
}) {
  return (
    <div className={`px-4 py-2.5 ${indent ? "pl-8" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!indent && <span className="text-[#06d6a0] text-[11px] font-semibold mr-2">{r.section}</span>}
          <span className="text-white text-sm">{snippet(r.body, 110)}</span>
          <div className="text-[11px] text-[#7ab5cc] mt-0.5">
            Answer: <span className="text-[#06d6a0]">{snippet(r.options[r.correct_index] ?? `#${r.correct_index}`, 40)}</span>
            {r.difficulty != null && <span className="text-[#4a8fa8] ml-2">· diff {r.difficulty}</span>}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <button
            onClick={onImprove}
            disabled={improving}
            title="AI: improve distractor options"
            className="text-[11px] px-2 py-1 rounded border border-[#333333] text-[#7ab5cc] hover:border-[#06d6a0]/40 hover:text-[#06d6a0] flex items-center gap-1"
          >
            {improving ? <Loader2 className="animate-spin" size={11} /> : <Sparkles size={11} />} AI options
          </button>
          <button
            onClick={onToggle}
            className={`text-[11px] px-2 py-1 rounded border ${
              r.is_active ? "border-[#06d6a0]/40 text-[#06d6a0]" : "border-[#333333] text-[#7ab5cc]"
            }`}
          >
            {r.is_active ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      {proposal && (
        <div className="mt-2 rounded-lg border border-[#06d6a0]/30 bg-[#06d6a0]/5 px-3 py-2.5 space-y-1.5">
          {proposal.rationale && <p className="text-[#ffd166] text-[11px]">{proposal.rationale}</p>}
          <div className="flex flex-wrap gap-1.5">
            {proposal.options.map((o, oi) => (
              <span key={oi} className={`text-[11px] px-1.5 py-0.5 rounded ${
                oi === proposal.correct_index
                  ? "bg-[#06d6a0]/15 text-[#06d6a0] border border-[#06d6a0]/40"
                  : "bg-[#120F17] text-[#7ab5cc] border border-[#222222]"
              }`}>
                {snippet(o, 50)}
              </span>
            ))}
          </div>
          {proposal.explanation && <p className="text-[#7ab5cc] text-[11px]">{snippet(proposal.explanation, 240)}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={onApply} disabled={applying}
              className="text-[11px] px-2.5 py-1 rounded bg-[#06d6a0] text-[#073b4c] font-semibold flex items-center gap-1">
              {applying && <Loader2 className="animate-spin" size={11} />} Apply
            </button>
            <button onClick={onDismiss} className="text-[11px] px-2.5 py-1 rounded border border-[#333333] text-[#7ab5cc]">
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Audit panel -------------------------------------------------------------

type FlaggedRow = {
  id: string;
  section: SectionCode;
  body: string;
  difficulty: number;
  elo: number;
  times_seen: number;
  attempts: number;
  correct_rate: number | null;
  reasons: string[];
};

type AuditVerdict = { id: string; verdict: "ok" | "suspect"; issues: string };

function AuditPanel({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const supabase = createClient() as AnyClient;
  const [flagged, setFlagged] = useState<FlaggedRow[]>([]);
  const [section, setSection] = useState<"ALL" | SectionCode>("ALL");
  const [auditing, setAuditing] = useState(false);
  const [progress, setProgress] = useState("");
  const [verdicts, setVerdicts] = useState<Record<string, AuditVerdict>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({}); // id → snippet for verdict display

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_flagged_questions");
    if (error) toast.error("Failed to load flags: " + error.message);
    setFlagged((data as FlaggedRow[]) ?? []);
  }, [supabase]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load, reloadKey]);

  async function deactivate(id: string) {
    const { error } = await supabase.rpc("admin_set_question_active", { p_id: id, p_active: false });
    if (error) {
      toast.error("Deactivate failed: " + error.message);
      return;
    }
    toast.success("Question deactivated");
    setFlagged((prev) => prev.filter((f) => f.id !== id));
    onChanged();
  }

  async function runAudit() {
    setAuditing(true);
    setVerdicts({});
    try {
      // Audit source: current flagged rows if any match the filter, else the
      // active bank for the chosen section. Cap 25 questions, batches of 5.
      const { data, error } = await supabase.rpc("admin_list_questions", {
        p_section: section === "ALL" ? null : section,
        p_active: true,
      });
      if (error) throw new Error(error.message);
      const all = (data as ListRow[]) ?? [];
      const flaggedIds = new Set(flagged.map((f) => f.id));
      const inScope = all.filter((r) => section === "ALL" || r.section === section);
      const prioritized = [
        ...inScope.filter((r) => flaggedIds.has(r.id)),
        ...inScope.filter((r) => !flaggedIds.has(r.id)),
      ].slice(0, 25);
      if (prioritized.length === 0) {
        toast.info("No active questions to audit");
        return;
      }
      setBodies(Object.fromEntries(prioritized.map((r) => [r.id, r.body])));

      const collected: Record<string, AuditVerdict> = {};
      for (let i = 0; i < prioritized.length; i += 5) {
        const batch = prioritized.slice(i, i + 5);
        setProgress(`Auditing ${Math.min(i + 5, prioritized.length)}/${prioritized.length}…`);
        const res = await fetch("/api/ninja/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questions: batch.map((r) => ({
              id: r.id, section: r.section, body: r.body, options: r.options,
              correct_index: r.correct_index, passage_body: r.passage_body,
            })),
          }),
        });
        const out = await res.json().catch(() => null);
        if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
        for (const v of out.verdicts as AuditVerdict[]) collected[v.id] = v;
        setVerdicts({ ...collected });
      }
      const suspects = Object.values(collected).filter((v) => v.verdict === "suspect").length;
      toast[suspects > 0 ? "warning" : "success"](
        suspects > 0 ? `${suspects} suspect question${suspects === 1 ? "" : "s"} found` : "All audited questions look OK");
    } catch (e) {
      toast.error("Audit failed: " + (e as Error).message);
    } finally {
      setAuditing(false);
      setProgress("");
    }
  }

  const suspectList = Object.values(verdicts).filter((v) => v.verdict === "suspect");
  const okCount = Object.values(verdicts).length - suspectList.length;

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-[#7ab5cc] text-sm font-medium flex items-center gap-1.5">
          <Sparkles size={14} className="text-[#ffd166]" /> Question audit
        </h2>
        <div className="flex gap-2 items-center">
          <select value={section} onChange={(e) => setSection(e.target.value as "ALL" | SectionCode)}
            className="bg-[#120F17] border border-[#333333] text-[#c5e8f0] text-sm rounded-lg px-2.5 py-1.5 focus:border-[#06d6a0] outline-none">
            <option value="ALL">All sections</option>
            {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button onClick={runAudit} disabled={auditing} size="sm"
            className="bg-[#ffd166] text-[#073b4c] font-semibold rounded-lg hover:bg-[#e6bc5c] flex items-center gap-1.5">
            {auditing ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
            {auditing ? progress || "Auditing…" : "AI-audit up to 25"}
          </Button>
        </div>
      </div>

      {/* Heuristic flags from play data */}
      {flagged.length === 0 ? (
        <p className="text-[#4a8fa8] text-xs">No heuristic flags — no active question has suspicious ELO drift or answer rates.</p>
      ) : (
        <div className="rounded-lg border border-[#ffd166]/30 overflow-hidden divide-y divide-[#222222]">
          {flagged.map((f) => (
            <div key={f.id} className="px-4 py-2.5 flex items-start justify-between gap-3 bg-[#ffd166]/5">
              <div className="min-w-0">
                <span className="text-[#06d6a0] text-[11px] font-semibold mr-2">{f.section}</span>
                <span className="text-white text-sm">{snippet(f.body, 100)}</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {f.reasons.map((r, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[#ffd166]/15 text-[#ffd166] border border-[#ffd166]/30">{r}</span>
                  ))}
                  <span className="text-[10px] text-[#4a8fa8] px-1.5 py-0.5">
                    ELO {f.elo} · seen {f.times_seen}
                    {f.attempts > 0 && f.correct_rate != null && ` · ${Math.round(f.correct_rate * 100)}% correct of ${f.attempts}`}
                  </span>
                </div>
              </div>
              <button onClick={() => deactivate(f.id)}
                className="shrink-0 text-[11px] px-2 py-1 rounded border border-[#ef476f]/40 text-[#ef476f] hover:bg-[#ef476f]/10">
                Deactivate
              </button>
            </div>
          ))}
        </div>
      )}

      {/* AI verdicts */}
      {Object.keys(verdicts).length > 0 && (
        <div className="space-y-2">
          <p className="text-[#7ab5cc] text-xs">
            AI audit: <span className="text-[#06d6a0]">{okCount} ok</span>
            {suspectList.length > 0 && <span className="text-[#ef476f]"> · {suspectList.length} suspect</span>}
          </p>
          {suspectList.map((v) => (
            <div key={v.id} className="rounded-lg border border-[#ef476f]/40 bg-[#ef476f]/5 px-4 py-2.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="text-white text-sm">{snippet(bodies[v.id] ?? v.id, 100)}</span>
                <p className="text-[#ef476f] text-[11px] mt-1">{v.issues}</p>
              </div>
              <button onClick={() => deactivate(v.id)}
                className="shrink-0 text-[11px] px-2 py-1 rounded border border-[#ef476f]/40 text-[#ef476f] hover:bg-[#ef476f]/10">
                Deactivate
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Fair play panel ---------------------------------------------------------

type SuspectRow = {
  match_id: string;
  username: string;
  ended_at: string;
  blur_correct: number;
  fast_correct: number;
  hard_correct: number;
  score: number;
};

function FairPlayPanel() {
  const supabase = createClient() as AnyClient;
  const [rows, setRows] = useState<SuspectRow[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  useEffect(() => {
    supabase.rpc("admin_suspect_matches").then(({ data, error }: { data: SuspectRow[] | null; error: { message: string } | null }) => {
      if (error) toast.error("Fair-play load failed: " + error.message);
      setRows(data ?? []);
    });
  }, [supabase]);

  async function summarize() {
    setSummarizing(true);
    try {
      const res = await fetch("/api/ninja/anticheat", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setSummary(data.content);
    } catch (e) {
      toast.error("Summary failed: " + (e as Error).message);
    } finally {
      setSummarizing(false);
    }
  }

  if (rows === null) return null;

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-[#7ab5cc] text-sm font-medium">Fair play · last 14 days</h2>
        {rows.length > 0 && (
          <Button onClick={summarize} disabled={summarizing} size="sm" variant="outline"
            className="border-[#333333] text-[#c5e8f0] hover:text-white hover:bg-[#1c1c1c] flex items-center gap-1.5">
            {summarizing ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
            Ninja read
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-[#4a8fa8] text-xs">No flagged rated matches. Signals watched: tab-blur then correct, sub-2s correct answers, wins far above rating.</p>
      ) : (
        <div className="rounded-lg border border-[#222222] overflow-hidden divide-y divide-[#222222]">
          {rows.map((r, i) => (
            <div key={`${r.match_id}-${r.username}-${i}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-white text-sm font-semibold">{r.username}</span>
                <span className="text-[#4a8fa8] text-[11px] ml-2">{new Date(r.ended_at).toLocaleDateString()}</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {r.blur_correct > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#ef476f]/15 text-[#ef476f] border border-[#ef476f]/30">
                      blur→correct ×{r.blur_correct}
                    </span>
                  )}
                  {r.fast_correct > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#ffd166]/15 text-[#ffd166] border border-[#ffd166]/30">
                      &lt;2s correct ×{r.fast_correct}
                    </span>
                  )}
                  {r.hard_correct > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#7ab5cc]/15 text-[#7ab5cc] border border-[#7ab5cc]/30">
                      +400 ELO correct ×{r.hard_correct}
                    </span>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-[#ffd166] text-sm font-bold tabular-nums">{r.score}</span>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="rounded-lg bg-[#120F17] px-4 py-3">
          <p className="text-[#c5e8f0] text-sm whitespace-pre-line leading-relaxed">{summary}</p>
        </div>
      )}
    </section>
  );
}

// ---- Page shell ------------------------------------------------------------

export default function AdminClient() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center">
          <h1 className="text-white font-semibold">Admin · Questions</h1>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <GeneratePanel onUpserted={() => setReloadKey((k) => k + 1)} />
        <UploadPanel onUpserted={() => setReloadKey((k) => k + 1)} />
        <AuditPanel reloadKey={reloadKey} onChanged={() => setReloadKey((k) => k + 1)} />
        <FairPlayPanel />
        <ContentList reloadKey={reloadKey} />
      </main>
    </div>
  );
}
