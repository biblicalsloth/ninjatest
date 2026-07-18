// Guards trimCurve — the thing standing between a long-career user's full
// rating history and 6 replays of it through the priciest metered route — and
// parsePlan, which is all that stands between whatever the model emits and the
// study-plan grid (plus the jsonb column it's cached in for a week).
// Run: node lib/ai/model.check.mts   (no network, no env)
import assert from "node:assert/strict";
import { trimCurve, CURVE_POINTS, parsePlan, PLAN_MAX_TASKS_PER_DAY } from "./model.ts";

const curve = (n: number) => Array.from({ length: n }, (_, i) => ({ elo: 1000 + i, at: `t${i}`, delta: 1 }));
const profile = (n: number) => ({ profile: { username: "u" }, rank: 1, curve: curve(n) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Under the cap: untouched, and no note claiming a truncation that didn't happen.
const small = trimCurve(profile(5)) as Any;
assert.equal(small.curve.length, 5);
assert.equal(small.curve_note, undefined);

// Over the cap: trimmed to the cap, sibling fields preserved, note added.
const big = trimCurve(profile(500)) as Any;
assert.equal(big.curve.length, CURVE_POINTS);
assert.equal(big.rank, 1);
assert.equal(big.profile.username, "u");
assert.match(big.curve_note, /500/);

// Keeps the MOST RECENT points — curve is ascending, so the tail is newest.
// Taking the head instead would feed the coach a stale trend and silently
// invert its advice (a rising player read as sliding).
assert.equal(big.curve.at(-1).elo, 1000 + 499);
assert.equal(big.curve[0].elo, 1000 + 500 - CURVE_POINTS);

// Exactly at the cap: no trim, no note (off-by-one guard).
const exact = trimCurve(profile(CURVE_POINTS)) as Any;
assert.equal(exact.curve.length, CURVE_POINTS);
assert.equal(exact.curve_note, undefined);

// Degenerate shapes pass through instead of throwing: the call helper's error
// object and a fresh player's empty curve both reach this path.
assert.deepEqual(trimCurve({ error: "unavailable" }), { error: "unavailable" });
assert.deepEqual(trimCurve(null), null);
assert.equal((trimCurve(profile(0)) as Any).curve.length, 0);

console.log("✅ trimCurve: cap, tail-order, passthrough, and error shapes all hold");

// ── parsePlan ──────────────────────────────────────────────────────────────
const ok = JSON.stringify({
  diagnosis: "Quant accuracy 0.41 and sliding (-1.8/match).",
  target: "Quant accuracy above 0.55 by Sunday.",
  days: {
    Mon: [{ section: "QUANT", task: "3 drills, TITA focus", minutes: 45 }],
    Sun: [{ section: "REST", task: "Off", minutes: 0 }],
  },
});
const p = parsePlan(ok);
assert.ok(p);
assert.equal(p.days.Mon?.[0].section, "QUANT");
assert.equal(p.days.Mon?.[0].minutes, 45);
assert.equal(p.days.Sun?.[0].section, "REST");
assert.equal(p.days.Tue, undefined); // absent day stays absent, not an empty lie

// Models fence their JSON and chat around it. Both must still parse — otherwise
// a perfectly good plan burns the fallback model and then 502s.
assert.ok(parsePlan("Here's your week!\n```json\n" + ok + "\n```\nGood luck!"));

// Junk drops the TASK, not the plan: an unknown section can't reach chipClass
// (no colour, renders bare), and a non-numeric minutes must not land NaN in the
// jsonb column and render "NaN min" for a week.
const dirty = parsePlan(JSON.stringify({
  days: {
    Mon: [
      { section: "QUANT", task: "keep", minutes: "forty" },
      { section: "ASTROLOGY", task: "drop", minutes: 30 },
      { section: "varc", task: "lowercase is fine", minutes: 20 },
      { section: "DILR", task: "   ", minutes: 20 },
      { section: "QUANT", task: "over cap", minutes: 9999 },
    ],
  },
}))!;
assert.ok(dirty);
assert.deepEqual(dirty.days.Mon?.map((t) => t.task), ["keep", "lowercase is fine", "over cap"]);
assert.equal(dirty.days.Mon?.[0].minutes, 0);   // NaN clamps to 0, never NaN
assert.equal(dirty.days.Mon?.[1].section, "VARC"); // case-normalized
assert.equal(dirty.days.Mon?.[2].minutes, 240);  // clamped to the ceiling
assert.equal(dirty.diagnosis, "");               // missing string ≠ undefined

// Per-day cap holds — a 40-task Monday must not blow up the grid or the row.
const flood = parsePlan(JSON.stringify({
  days: { Mon: Array.from({ length: 40 }, () => ({ section: "QUANT", task: "x", minutes: 10 })) },
}))!;
assert.equal(flood.days.Mon?.length, PLAN_MAX_TASKS_PER_DAY);

// Failures must be null, so the route tries its fallback model instead of
// caching a blank week that first-write-wins then refuses to replace.
assert.equal(parsePlan("I'd love to help! What section?"), null); // no JSON at all
assert.equal(parsePlan("{not json}"), null);
assert.equal(parsePlan(JSON.stringify({ days: {} })), null);      // zero valid tasks
assert.equal(parsePlan(JSON.stringify({ days: { Mon: "45 min quant" } })), null); // days as prose
assert.equal(parsePlan(JSON.stringify({ days: { Xyz: [{ section: "QUANT", task: "t", minutes: 5 }] } })), null);

console.log("✅ parsePlan: fences, junk-drop, NaN/clamp, per-day cap, and null-on-failure all hold");
