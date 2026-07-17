// Guards trimCurve — the thing standing between a long-career user's full
// rating history and 6 replays of it through the priciest metered route.
// Run: node lib/ai/model.check.mts   (no network, no env)
import assert from "node:assert/strict";
import { trimCurve, CURVE_POINTS } from "./model.ts";

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
