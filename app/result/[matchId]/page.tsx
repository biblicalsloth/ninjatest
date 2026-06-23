import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ResultClient from "./result-client";

export default async function ResultPage({ params }: { params: Promise<{ matchId: string }> }) {
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

  const isPlayerA = match.player_a === user.id;
  const opponentId = isPlayerA ? match.player_b : match.player_a;

  const [{ data: myProfile }, { data: oppProfile }, { data: myAnswers }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase.from("profiles").select("*").eq("id", opponentId).single(),
    supabase.from("match_answers").select("*").eq("match_id", matchId).eq("user_id", user.id).order("question_index"),
  ]);

  if (!myProfile || !oppProfile) redirect("/lobby");

  return (
    <ResultClient
      match={match}
      myProfile={myProfile}
      oppProfile={oppProfile}
      isPlayerA={isPlayerA}
      myAnswers={myAnswers ?? []}
    />
  );
}
