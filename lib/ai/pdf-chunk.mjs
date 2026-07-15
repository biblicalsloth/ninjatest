// Pure page-range chunker: splits a PDF's pages into bounded groups so each
// LLM extraction call stays small. Returns [start, end) 0-based index pairs.
// ponytail: off-by-one is the only real bug surface — guarded by
// scripts/check-extract-chunks.mjs.
export function chunkRanges(totalPages, size) {
  if (totalPages <= 0 || size <= 0) return [];
  const ranges = [];
  for (let start = 0; start < totalPages; start += size) {
    ranges.push([start, Math.min(start + size, totalPages)]);
  }
  return ranges;
}
