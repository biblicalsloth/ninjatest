import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendChallengeInvite } from "@/lib/email";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { to, code, is_rated } = await req.json() as { to: string; code: string; is_rated: boolean };
  if (!to || !code) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, username")
    .eq("id", user.id)
    .single();

  const fromUsername = (profile as { display_name: string | null; username: string } | null)?.display_name
    ?? (profile as { display_name: string | null; username: string } | null)?.username
    ?? "Someone";

  const origin = req.headers.get("origin") ?? "https://ninjatest.vercel.app";

  const { error } = await sendChallengeInvite({ to, fromUsername, code, isRated: is_rated, origin });
  if (error) return NextResponse.json({ error: "Failed to send email" }, { status: 500 });

  return NextResponse.json({ ok: true });
}
