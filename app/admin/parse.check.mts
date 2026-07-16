// Self-check for the admin upload parser. No network, no env, no deps:
//
//   node app/admin/parse.check.mts
//
// Node 24 strips types natively, so this needs no test runner. parse.ts:2 has
// claimed this file exists since it was written; it did not. It guards the
// things that silently produce a WRONG question bank rather than an error:
//   - a tita row accepted without answer_value (unscoreable forever:
//     tita_matches(x, null) is false for every x)
//   - a tita row smuggling options/correct_index through to the MCQ branch
//   - a blank CSV correct_index landing as 0 ("option A is correct")
import { parseJson, parseCsv } from "./parse.ts";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) return;
  failed++;
  console.error(`FAIL: ${name}`);
}
function throws(name: string, fn: () => unknown, match?: RegExp) {
  try {
    fn();
    failed++;
    console.error(`FAIL: ${name} — expected a throw, got none`);
  } catch (e) {
    if (match && !match.test((e as Error).message)) {
      failed++;
      console.error(`FAIL: ${name} — message ${JSON.stringify((e as Error).message)} !~ ${match}`);
    }
  }
}

// ── MCQ still parses exactly as before (qtype defaults, no answer_value) ──
{
  const g = parseJson(JSON.stringify([
    { section: "QUANT", body: "2+2?", options: ["3", "4"], correct_index: 1 },
  ]));
  const q = g[0].questions[0];
  check("mcq: qtype defaults to mcq", q.qtype === "mcq");
  check("mcq: options preserved", q.options.length === 2 && q.options[1] === "4");
  check("mcq: correct_index preserved", q.correct_index === 1);
  check("mcq: no answer_value", q.answer_value === undefined);
}

// ── TITA parses, and does NOT carry option/index data ──
{
  const g = parseJson(JSON.stringify([
    { section: "QUANT", body: "Smallest n?", qtype: "tita", answer_value: " 8 " },
  ]));
  const q = g[0].questions[0];
  check("tita: qtype kept", q.qtype === "tita");
  check("tita: answer_value trimmed", q.answer_value === "8");
  check("tita: options forced empty", Array.isArray(q.options) && q.options.length === 0);
  check("tita: correct_index forced 0", q.correct_index === 0);
}

// ── A tita row must not be able to smuggle a correct_index through ──
{
  const g = parseJson(JSON.stringify([
    { section: "QUANT", body: "x?", qtype: "tita", answer_value: "5", options: ["a", "b"], correct_index: 1 },
  ]));
  const q = g[0].questions[0];
  check("tita: supplied options discarded", q.options.length === 0);
  check("tita: supplied correct_index discarded", q.correct_index === 0);
}

// ── The unscoreable-row guards ──
throws("tita without answer_value rejected",
  () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", qtype: "tita" }])),
  /answer_value/);
throws("tita with blank answer_value rejected",
  () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", qtype: "tita", answer_value: "   " }])),
  /answer_value/);
throws("unknown qtype rejected",
  () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", qtype: "essay", answer_value: "1" }])),
  /qtype/);
throws("mcq still requires options",
  () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", correct_index: 0 }])),
  /options/);
throws("mcq still requires in-range correct_index",
  () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", options: ["a", "b"], correct_index: 5 }])),
  /correct_index/);

// ── Numeric-key rule: the answer box is digits-only, so a unit key is unanswerable ──
{
  for (const ok of ["1900", "1,234", "0", "8", "0.5", "-3", ".5", "+12"]) {
    const g = parseJson(JSON.stringify([{ section: "QUANT", body: "x?", qtype: "tita", answer_value: ok }]));
    check(`tita key ${JSON.stringify(ok)} accepted`, g[0].questions[0].answer_value === ok);
  }
  for (const bad of ["Rs.1900", "1900m", "1900 metres", "one thousand", "abc", "1900 or 2000", "~1900"]) {
    throws(`tita key ${JSON.stringify(bad)} rejected`,
      () => parseJson(JSON.stringify([{ section: "QUANT", body: "x?", qtype: "tita", answer_value: bad }])),
      /numeric/);
  }
}

// ── The in-match input pattern must accept every state you type THROUGH ──
// (kept in step with TITA_INPUT in match-client.tsx)
{
  const TITA_INPUT = /^-?[0-9]*(?:,[0-9]*)*(?:\.[0-9]*)?$/;
  for (const s of ["", "-", "1", "19", "1,", "1,9", "1,900", "1900.", "1900.5", "-3", ".5"])
    check(`input allows intermediate ${JSON.stringify(s)}`, TITA_INPUT.test(s));
  for (const s of ["R", "Rs.1900", "1900m", "1900 metres", "1 900", "abc", "1900 "])
    check(`input blocks ${JSON.stringify(s)}`, !TITA_INPUT.test(s));
}

// ── CSV: mixed sheet ──
{
  const csv = [
    "section,body,qtype,options,correct_index,answer_value",
    'QUANT,"2+2?",mcq,3|4,1,',
    'QUANT,"Smallest n?",tita,,,8',
    'QUANT,"Default type?",,3|4,0,',
  ].join("\n");
  const groups = parseCsv(csv);
  const qs = groups.flatMap((g) => g.questions);
  check("csv: 3 rows parsed", qs.length === 3);
  check("csv: mcq row", qs[0].qtype === "mcq" && qs[0].correct_index === 1);
  check("csv: tita row", qs[1].qtype === "tita" && qs[1].answer_value === "8" && qs[1].options.length === 0);
  check("csv: blank qtype cell defaults to mcq", qs[2].qtype === "mcq");
}

// ── CSV: the blank-correct_index hazard ──
throws("csv: blank correct_index on an mcq row is rejected, not read as 0",
  () => parseCsv(["section,body,qtype,options,correct_index,answer_value",
                  'QUANT,"2+2?",mcq,3|4,,'].join("\n")),
  /correct_index/);

// ── CSV: header contracts ──
throws("csv: pre-TITA sheet still demands options+correct_index",
  () => parseCsv(["section,body", "QUANT,x"].join("\n")),
  /options, correct_index/);
throws("csv: qtype column without answer_value column is rejected",
  () => parseCsv(["section,body,qtype,options,correct_index", "QUANT,x,mcq,a|b,0"].join("\n")),
  /answer_value/);

// ── TITA-only sheet needs no options/correct_index columns at all ──
{
  const groups = parseCsv(["section,body,qtype,answer_value", 'QUANT,"n?",tita,42'].join("\n"));
  const q = groups[0].questions[0];
  check("csv: tita-only sheet parses", q.qtype === "tita" && q.answer_value === "42");
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("parse.check: all checks passed");
