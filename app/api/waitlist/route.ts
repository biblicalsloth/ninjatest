import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { name, email, phone, year, percentile, section } = body as Record<string, string>;

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME ?? "Waitlist";

  if (!apiKey || !baseId) {
    // Airtable not configured yet — log and succeed silently
    console.warn("Airtable env vars missing — submission not saved", { name, email });
    return NextResponse.json({ ok: true });
  }

  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        Name: name ?? "",
        Email: email.toLowerCase().trim(),
        Phone: phone ?? "",
        "CAT Target Year": year ?? "",
        "Mock Percentile": percentile ?? "",
        "Weakest Section": section ?? "",
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Airtable error", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
