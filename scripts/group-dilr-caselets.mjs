// Group atomized DILR questions back into their shared caselets.
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
//   node scripts/group-dilr-caselets.mjs            # dry run: report only
//   node scripts/group-dilr-caselets.mjs --apply    # execute
//   node scripts/group-dilr-caselets.mjs --self-test # offline logic check, no env

import { createClient } from "@supabase/supabase-js";

const MIN_CASELET = 120; // shared prefix shorter than this is not a real caselet
const MIN_GROUP = 3; // picker only serves passage groups of >= 3

function lcpLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
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
    const cut = raw.lastIndexOf("\n\n"); // caselet ends at last shared paragraph break
    const caselet = cut >= 0 ? raw.slice(0, cut).trimEnd() : "";
    if (caselet.length < MIN_CASELET) {
      skipped.push({ reason: "caselet-too-short", size: run.length, head: raw.slice(0, 60) });
      continue;
    }
    const members = run.map((r) => ({ ...r, stem: r.body.slice(cut).replace(/^\s+/, "") }));
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
  console.log("self-test OK:", clusters[0].members.length, "grouped, caselet", C.length, "chars");
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

  const { data: rows, error } = await sb
    .from("questions")
    .select("id, body, image_url, created_at, qtype")
    .eq("section", "DILR")
    .eq("is_active", true)
    .is("passage_id", null) // idempotent: skip already-grouped
    .limit(5000);
  if (error) throw error;

  const { clusters, skipped } = planGrouping(rows);
  const grouped = clusters.reduce((n, c) => n + c.members.length, 0);
  console.log(`DILR active ungrouped: ${rows.length}`);
  console.log(`clusters (>=${MIN_GROUP}): ${clusters.length}  -> ${grouped} questions grouped`);
  console.log(`left standalone: ${rows.length - grouped}`);
  if (skipped.length) console.log(`skipped runs (not grouped): ${skipped.length}`, skipped.slice(0, 5));
  const sizes = {};
  for (const c of clusters) sizes[c.members.length] = (sizes[c.members.length] || 0) + 1;
  console.log("cluster sizes {size:count}:", sizes);
  console.log("\nsample cluster:");
  if (clusters[0]) {
    console.log("  caselet:", clusters[0].caselet.slice(0, 180).replace(/\n/g, " "), "…");
    clusters[0].members.forEach((m) => console.log("   - stem:", m.stem.slice(0, 90).replace(/\n/g, " ")));
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to execute.");
    return;
  }

  // insurance snapshot (reversal is also derivable: orig = passage.body + "\n\n" + stem)
  const { writeFileSync } = await import("node:fs");
  const snap = clusters.flatMap((c) => c.members.map((m) => ({ id: m.id, body: m.body })));
  const snapPath = `/private/tmp/claude-501/-Users-macbookpro-Documents-ninjatest/1b1e949a-e387-4609-8569-8c85cb478cc5/scratchpad/dilr-body-backup.json`;
  writeFileSync(snapPath, JSON.stringify(snap));
  console.log(`\nbackup of ${snap.length} original bodies -> ${snapPath}`);

  let np = 0, nq = 0;
  for (const c of clusters) {
    const { data: passage, error: pe } = await sb
      .from("passages")
      .insert({ section: "DILR", body: c.caselet, is_active: true })
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
