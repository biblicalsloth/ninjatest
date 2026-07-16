import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { type AiConfig } from "@/lib/ai/model";
import { extractQuestions } from "@/lib/ai/extract";

export const runtime = "nodejs";   // pdf-lib needs Node
export const maxDuration = 300;    // many chunks × LLM calls

const MAX_BYTES = 20 * 1024 * 1024; // 20MB upload ceiling

// User-facing PDF solver. Any signed-in player uploads a test/sample paper;
// Ninja extracts every question and solves it (answer + explanation). Ephemeral:
// nothing is saved and nothing touches the question bank — that's the admin-only
// /api/ninja/extract flow. Same pipeline (extractQuestions), no admin gate,
// tighter rate limit since callers are untrusted.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // Metered LLM: fail-closed so a limiter blip can't become an unmetered-spend
  // hole. Tighter than the admin extractor — a 60-page PDF is real spend.
  const rl = await rateLimitDb(supabase, user.id, "ninja-solve-user", { limit: 5, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-solve-ip", { limit: 10, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Solve limit reached. Try again in a bit." },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Upload a PDF file in the 'file' field." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") return NextResponse.json({ error: "File must be a PDF." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "PDF too large (max 20MB)." }, { status: 400 });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { groups, warnings } = await extractQuestions(bytes, config);
    return NextResponse.json({ groups, warnings });
  } catch (e) {
    // splitPdf throws user-actionable messages (empty / too many pages).
    const msg = e instanceof Error ? e.message : "Extraction failed";
    console.error("Ninja solve failed:", e);
    const bad = /no pages|pages;/.test(msg);
    return NextResponse.json({ error: bad ? msg : "Could not read questions from that PDF" }, { status: bad ? 400 : 502 });
  }
}
