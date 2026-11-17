// Group atomized DILR (or QUANT) questions back into their shared caselets.
//
// QUANT (2026-11-18): 125 QUANT rows are atomized sets too ("Answer the
// questions based on the following information. …"); --section QUANT groups the
// >=3 runs. Most QUANT bodies have no "\n\n" between setup and stem, so the cut
// falls back to the last sentence end inside the shared prefix. Pairs and
// singletons stay standalone with their full text — the picker near-dup guard
// (20261118000100) keeps sibling pairs out of the same match. The picker
// migration MUST be live before --apply on QUANT, or the old QUANT picker
// serves the now setup-less stems standalone.
//
// The DILR bank was extracted question-by-question: every question body is
// [verbatim caselet] + "\n\n" + [unique question stem], and the caselet was
// copied into each sibling. So passages is empty, passage_id is null on all of
// them, and the match picker serves DILR as unrelated standalone questions —
// three different caselets per game instead of three questions on one caselet.
//
// This reunites them to the VARC model that get_match_question + match-client
// already render (passages.body = shared caselet, questions.body = stem only,
// lib/ai/extract.ts's own contract). Then pick_section_question_ids' existing
// passage-group branch serves them together, no picker change needed.
//
// Method (deterministic, no LLM):
//   1. Sort active DILR bodies lexicographically -> identical caselets are adjacent.
//   2. Cut into runs where consecutive longest-common-prefix >= MIN_CASELET.
//   3. Per run of >= MIN_GROUP, caselet = common prefix of all members, trimmed
//      to the last "\n\n" paragraph boundary; each stem = body minus caselet.
//   4. Create one passages row (caselet), point members at it, replace each body
//      with its stem. image_url is LEFT UNTOUCHED on every question (each keeps
//      whatever diagram it shipped with) — zero image risk.
//
// Safe by construction: reversible without a backup (original body ==
// passage.body + "\n\n" + question.body), idempotent (skips passage_id-set rows),
// only groups >= MIN_GROUP so nothing lands in the picker's dead zone (a 2-group
// is served by neither branch), and a JSON snapshot is still dumped as insurance.
//
// NOTE: updating body fires questions_null_stale_embedding_trg -> nulls the
// embedding on every touched row. Re-run `node scripts/backfill-embeddings.mjs`
// after applying.
//
//   node scripts/group-dilr-caselets.mjs                    # dry run, DILR
//   node scripts/group-dilr-caselets.mjs --section QUANT    # dry run, QUANT
//   node scripts/group-dilr-caselets.mjs --section QUANT --apply [--backup <file>]
//   node scripts/group-dilr-caselets.mjs --self-test        # offline logic check, no env

import { createClient } from "@supabase/supabase-js";

const MIN_CASELET = 120; // shared prefix shorter than this is not a real caselet
const MIN_GROUP = 3; // picker only serves passage groups of >= 3
// If the stems still share this much text after the cut, the cut landed inside
// shared text — e.g. QUANT data-sufficiency boilerplate, where independent
// questions share an instruction block and its (a)-(d) option list. Those are
// not sets; leave them standalone. Real set stems diverge within a few words
// ("Number of persons in…", "Amit wants to reach…" ~20 chars).
const MAX_STEM_LCP = 30;

function lcpLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Where the shared caselet ends inside the common prefix `raw`: the last
// paragraph break, else the last sentence end (". " / "? " / ": "), else -1.
// Returns the index the stem starts at (whitespace after it is stripped later).
export function caseletCut(raw) {
  const para = raw.lastIndexOf("\n\n");
  if (para >= 0) return para;
  const m = [...raw.matchAll(/[.?:]\s/g)].pop();
  return m ? m.index + 1 : -1;
}

// Split sorted rows into caselet clusters and compute caselet + stems.
// Returns { clusters:[{caselet, members:[{...row, stem}]}], skipped:[...] }.
export function planGrouping(rows) {
  const sorted = [...rows].sort((a, b) => (a.body < b.body ? -1 : a.body > b.body ? 1 : 0));
  const runs = [];
  let cur = sorted.length ? [sorted[0]] : [];
  for (let i = 1; i < sorted.length; i++) {
    if (lcpLen(sorted[i - 1].body, sorted[i].body) >= MIN_CASELET) cur.push(sorted[i]);
    else {
      runs.push(cur);
      cur = [sorted[i]];
    }
  }
  if (cur.length) runs.push(cur);

  const clusters = [];
  const skipped = [];
  for (const run of runs) {
    if (run.length < MIN_GROUP) continue; // stays standalone
    // common prefix of the whole run = min adjacent LCP (sorted set)
    let cp = run[0].body.length;
    for (let i = 1; i < run.length; i++) cp = Math.min(cp, lcpLen(run[i - 1].body, run[i].body));
    const raw = run[0].body.slice(0, cp);
    const cut = caseletCut(raw); // last shared paragraph break, else sentence end
    const caselet = cut >= 0 ? raw.slice(0, cut).trimEnd() : "";
    if (caselet.length < MIN_CASELET) {
      skipped.push({ reason: "caselet-too-short", size: run.length, head: raw.slice(0, 60) });
      continue;
    }
    const members = run.map((r) => ({ ...r, stem: r.body.slice(cut).replace(/^\s+/, "") }));
    const stemLcp = Math.min(...members.slice(1).map((m, i) => lcpLen(members[i].stem, m.stem)));
    if (stemLcp >= MAX_STEM_LCP) {
      skipped.push({ reason: "cut-inside-shared-text", size: run.length, head: members[0].stem.slice(0, 60) });
      continue;
    }
    if (members.some((m) => m.stem.length === 0)) {
      skipped.push({ reason: "empty-stem", size: run.length, head: caselet.slice(0, 60) });
      continue;
    }
    clusters.push({ caselet, members });
  }
  return { clusters, skipped };
}

function selfTest() {
  const C = "A committee of five is to be formed from a pool of many candidates with assorted constraints on who may serve together on the board.";
  const rows = [
    { id: "1", body: `${C}\n\nWho must be on the committee?`, image_url: null },
    { id: "2", body: `${C}\n\nWho cannot serve with X?`, image_url: "u2" },
    { id: "3", body: `${C}\n\nHow many valid committees exist?`, image_url: null },
    // unrelated singleton, different caselet
    { id: "4", body: "A train leaves station P at noon travelling east at a steady speed toward Q.", image_url: null },
  ];
  const { clusters, skipped } = planGrouping(rows);
  console.assert(clusters.length === 1, "expected 1 cluster, got", clusters.length);
  console.assert(clusters[0].members.length === 3, "expected 3 members");
  console.assert(clusters[0].caselet === C, "caselet mismatch:", JSON.stringify(clusters[0].caselet));
  console.assert(
    clusters[0].members.every((m) => m.stem && !m.stem.includes(C)),
    "stem still contains caselet",
  );
  const stems = clusters[0].members.map((m) => m.stem).sort();
  console.assert(stems.includes("Who must be on the committee?"), "expected stem missing:", stems);
  console.assert(skipped.length === 0, "unexpected skips", skipped);
  // QUANT shape: setup and stem on one line, no paragraph break.
  const S = "Answer the questions based on the following information. A boy is asked to put one mango in a basket when ordered One, one orange when ordered Two.";
  const q = planGrouping([
    { id: "a", body: `${S} How many mangoes after 10 orders?` },
    { id: "b", body: `${S} How many oranges after 10 orders?` },
    { id: "c", body: `${S} What is the total after 20 orders?` },
  ]);
  console.assert(q.clusters.length === 1, "QUANT: expected 1 cluster", q);
  console.assert(q.clusters[0]?.caselet === S, "QUANT caselet mismatch:", JSON.stringify(q.clusters[0]?.caselet));
  console.assert(
    q.clusters[0]?.members.every((m) => /^(How|What)/.test(m.stem)),
    "QUANT stems should start at the question", q.clusters[0]?.members.map((m) => m.stem),
  );
  console.assert(caseletCut("no boundary here") === -1, "no boundary -> -1");
  // Data-sufficiency boilerplate: shared instructions + option list, independent
  // questions. Must NOT group.
  const DS = "Each question is followed by two statements. Mark (a) if one statement alone suffices. Mark (b) if both are needed.";
  const ds = planGrouping([
    // Real shape: the copies diverge mid-sentence inside the boilerplate
    // ("both statements together" vs "both the statements"), so the sentence
    // cut lands before "(d)…" and every stem starts with the same 40+ chars.
    { id: "x", body: `${DS} Mark (d) if the question cannot be answered even with the help of both statements. What is x?` },
    { id: "y", body: `${DS} Mark (d) if the question cannot be answered even with the help of both statements together. Is y even?` },
    { id: "z", body: `${DS} Mark (d) if the question cannot be answered even with the help of both the statements. Find z.` },
  ]);
  console.assert(ds.clusters.length === 0, "DS boilerplate must not group", ds.clusters.map((c) => c.members.map((m) => m.stem)));
  console.log("self-test OK:", clusters[0].members.length, "grouped, caselet", C.length, "chars; QUANT sentence-cut OK");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const { loadEnvLocal } = await import("./env.mjs");
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const apply = process.argv.includes("--apply");
  const argAt = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
  const section = argAt("--section") ?? "DILR";
  if (!["DILR", "QUANT"].includes(section)) throw new Error(`--section must be DILR or QUANT, got ${section}`);

  const { data: rows, error } = await sb
    .from("questions")
    .select("id, body, image_url, created_at, qtype")
    .eq("section", section)
    .eq("is_active", true)
    .is("passage_id", null) // idempotent: skip already-grouped
    .limit(5000);
  if (error) throw error;

  const { clusters, skipped } = planGrouping(rows);
  const grouped = clusters.reduce((n, c) => n + c.members.length, 0);
  console.log(`${section} active ungrouped: ${rows.length}`);
  console.log(`clusters (>=${MIN_GROUP}): ${clusters.length}  -> ${grouped} questions grouped`);
  console.log(`left standalone: ${rows.length - grouped}`);
  if (skipped.length) console.log(`skipped runs (not grouped): ${skipped.length}`, skipped.slice(0, 5));
  const sizes = {};
  for (const c of clusters) sizes[c.members.length] = (sizes[c.members.length] || 0) + 1;
  console.log("cluster sizes {size:count}:", sizes);
  // Every cut, not a sample: review where each caselet ends before --apply.
  console.log("\nclusters (caselet tail | stem heads):");
  for (const c of clusters) {
    console.log(`\n  [${c.members.length}] …${c.caselet.slice(-90).replace(/\n/g, " ")}`);
    c.members.forEach((m) => console.log("     > " + m.stem.slice(0, 80).replace(/\n/g, " ")));
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to execute.");
    return;
  }

  // insurance snapshot (reversal is also derivable: orig = passage.body + "\n\n" + stem)
  const { writeFileSync } = await import("node:fs");
  const snap = clusters.flatMap((c) => c.members.map((m) => ({ id: m.id, body: m.body })));
  const snapPath = argAt("--backup") ?? `${section.toLowerCase()}-body-backup-${Date.now()}.json`;
  writeFileSync(snapPath, JSON.stringify(snap));
  console.log(`\nbackup of ${snap.length} original bodies -> ${snapPath}`);

  let np = 0, nq = 0;
  for (const c of clusters) {
    const { data: passage, error: pe } = await sb
      .from("passages")
      .insert({ section, body: c.caselet, is_active: true })
      .select("id")
      .single();
    if (pe) throw pe;
    np++;
    for (const m of c.members) {
      const { error: ue } = await sb
        .from("questions")
        .update({ passage_id: passage.id, body: m.stem })
        .eq("id", m.id);
      if (ue) throw ue;
      nq++;
    }
    if (np % 25 === 0) console.log(`  ${np}/${clusters.length} caselets, ${nq} questions…`);
  }
  console.log(`\nDONE. created ${np} passages, moved ${nq} questions.`);
  console.log("Embeddings on moved rows were nulled by the staleness trigger —");
  console.log("run:  node scripts/backfill-embeddings.mjs");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
