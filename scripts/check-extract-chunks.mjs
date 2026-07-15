// Runnable check for the PDF page chunker. `node scripts/check-extract-chunks.mjs`
import assert from "node:assert/strict";
import { chunkRanges } from "../lib/ai/pdf-chunk.mjs";

assert.deepEqual(chunkRanges(0, 4), []);                       // empty PDF
assert.deepEqual(chunkRanges(3, 4), [[0, 3]]);                 // smaller than one chunk
assert.deepEqual(chunkRanges(4, 4), [[0, 4]]);                 // exact fit, no empty tail
assert.deepEqual(chunkRanges(8, 4), [[0, 4], [4, 8]]);
assert.deepEqual(chunkRanges(9, 4), [[0, 4], [4, 8], [8, 9]]); // ragged tail
assert.equal(chunkRanges(60, 4).length, 15);
assert.deepEqual(chunkRanges(5, 0), []);                       // bad size guarded
console.log("chunkRanges OK");
