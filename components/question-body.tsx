// Renders a question body that is plain text except for GFM-style pipe tables.
// DILR passages inline data tables as `| a | b |` markdown; everything else is
// prose with newlines. We only parse tables — not a full markdown pass — because
// tables are the only markup the question bank emits.
// ponytail: pipe-table only; if bodies ever gain bold/lists, reach for a real md lib.
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

type Block = { kind: "text"; text: string } | { kind: "table"; head: string[] | null; rows: string[][] };

function parse(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length) { blocks.push({ kind: "text", text: text.join("\n") }); text = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    // a table = a run of pipe-rows, at least two lines long
    if (isRow(lines[i]) && i + 1 < lines.length && isRow(lines[i + 1])) {
      flushText();
      const run: string[] = [];
      while (i < lines.length && isRow(lines[i])) run.push(lines[i++]);
      i--;
      let head: string[] | null = null;
      let bodyRows = run;
      if (run.length >= 2 && isDivider(run[1])) { head = cells(run[0]); bodyRows = run.slice(2); }
      blocks.push({ kind: "table", head, rows: bodyRows.map(cells) });
    } else {
      text.push(lines[i]);
    }
  }
  flushText();
  return blocks;
}

export function QuestionBody({ body, className }: { body: string; className?: string }) {
  const blocks = parse(body);
  // no table -> keep the original single pre-wrap node (identical to before)
  if (blocks.every((b) => b.kind === "text")) {
    return <div className={className} style={{ whiteSpace: "pre-wrap" }}>{body}</div>;
  }
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {blocks.map((b, i) =>
        b.kind === "text" ? (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>{b.text}</div>
        ) : (
          <div key={i} style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%", fontSize: "0.92em", fontVariantNumeric: "tabular-nums" }}>
              {b.head && (
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j} style={{ border: "1px solid #333", padding: "6px 10px", textAlign: "left", color: "#c5e8f0", background: "#181818", fontWeight: 600 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => (
                      <td key={ci} style={{ border: "1px solid #2a2a2a", padding: "6px 10px", textAlign: "left" }}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}
