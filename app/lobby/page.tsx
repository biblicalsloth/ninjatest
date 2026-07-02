import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LobbyClient from "./lobby-client";

export default async function LobbyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ data: recentMatches }, { data: dailyProgress }] = await Promise.all([
    (supabase as any).rpc("get_recent_matches", { p_limit: 5 }),
    (supabase as any).rpc("get_daily_progress"),
  ]);

  return (
    <LobbyClient
      profile={profile}
      recentMatches={recentMatches ?? []}
      dailyProgress={dailyProgress ?? { matches_today: 0, wins_today: 0 }}
    />
  );
}
