import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { type AiConfig } from "@/lib/ai/model";
import { extractQuestions } from "@/lib/ai/extract";

export const runtime = "nodejs";   // pdf-lib needs Node
export const maxDuration = 300;    // many chunks × LLM calls

const MAX_BYTES = 20 * 1024 * 1024; // 20MB upload ceiling

// Admin-only PDF → question extractor. Returns groups shaped for
// admin_upsert_questions; the admin reviews/edits in the console and submits
// there. This route never writes to the question bank.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!prof?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Metered LLM: fail-closed so a limiter blip can't become an unmetered-spend hole.
  const rl = await rateLimitDb(supabase, user.id, "ninja-extract-user", { limit: 20, windowSeconds: 3600, failClosed: true });
  if (!rl.ok) {
    return NextResponse.json({ error: "Extraction limit reached. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }
  await rateLimitDb(supabase, clientIp(req), "ninja-extract-ip", { limit: 40, windowSeconds: 3600, failClosed: true });

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
    console.error("Ninja extract failed:", e);
    const bad = /no pages|pages;/.test(msg);
    return NextResponse.json({ error: bad ? msg : "Could not extract questions from that PDF" }, { status: bad ? 400 : 502 });
  }
}
