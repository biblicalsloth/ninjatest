import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendMatchResult } from "@/lib/email";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { match_id } = await req.json() as { match_id: string };
  if (!match_id) return NextResponse.json({ error: "Missing match_id" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: matchRaw } = await (supabase as any).from("matches").select("*").eq("id", match_id).single();
  const match = matchRaw as import("@/lib/supabase/types").Match | null;
  if (!match || (match.player_a !== user.id && match.player_b !== user.id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const isPlayerA = match.player_a === user.id;
  const opponentId = isPlayerA ? match.player_b : match.player_a;

  const [{ data: myProfileRaw }, { data: oppProfileRaw }] = await Promise.all([
    supabase.from("profiles").select("username, display_name, email").eq("id", user.id).single(),
    supabase.from("profiles").select("username, display_name").eq("id", opponentId).single(),
  ]);

  type ProfileRow = { username: string; display_name: string | null; email?: string };
  const myProfile = myProfileRaw as ProfileRow | null;
  const oppProfile = oppProfileRaw as ProfileRow | null;

  const userEmail = user.email;
  if (!userEmail || !myProfile || !oppProfile) {
    return NextResponse.json({ error: "Missing profile data" }, { status: 400 });
  }

  const myScore = isPlayerA ? match.score_a : match.score_b;
  const oppScore = isPlayerA ? match.score_b : match.score_a;
  const myEloBefore = isPlayerA ? match.elo_a_before : match.elo_b_before;
  const myEloAfter = isPlayerA ? match.elo_a_after : match.elo_b_after;
  const eloDelta = myEloAfter != null && myEloBefore != null ? myEloAfter - myEloBefore : null;

  const result: "win" | "loss" | "draw" =
    match.winner_id === user.id ? "win"
    : match.winner_id === null && match.status === "completed" ? "draw"
    : "loss";

  const origin = req.headers.get("origin") ?? "https://ninjatest.vercel.app";

  const { error } = await sendMatchResult({
    to: userEmail,
    username: myProfile.display_name ?? myProfile.username,
    opponent: oppProfile.display_name ?? oppProfile.username,
    myScore,
    oppScore,
    result,
    eloDelta,
    isRated: match.is_rated,
    origin,
  });

  if (error) return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
