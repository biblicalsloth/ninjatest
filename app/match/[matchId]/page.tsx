import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import MatchClient from "./match-client";

export default async function MatchPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: matchRaw } = await supabase
    .from("matches")
    .select("*")
    .eq("id", matchId)
    .single();

  const match = matchRaw as import("@/lib/supabase/types").Match | null;

  if (!match || (match.player_a !== user.id && match.player_b !== user.id)) {
    redirect("/lobby");
  }

  if (match.status === "completed" || match.status === "abandoned") {
    redirect(`/result/${matchId}`);
  }

  const isPlayerA = match.player_a === user.id;
  const opponentId = isPlayerA ? match.player_b : match.player_a;

  const { data: myProfile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  const { data: oppProfile } = await supabase.from("profiles").select("*").eq("id", opponentId).single();

  if (!myProfile || !oppProfile) redirect("/lobby");

  return (
    <MatchClient
      match={match}
      myProfile={myProfile}
      oppProfile={oppProfile}
      isPlayerA={isPlayerA}
      userId={user.id}
    />
  );
}
