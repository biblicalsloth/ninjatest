import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LobbyClient from "./lobby-client";

export default async function LobbyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const [
    { data: profile },
    { data: recentMatches },
    { data: dailyProgress },
    { data: friends },
    { data: incomingChallenges },
    { count: unreadCount },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    sb.rpc("get_recent_matches", { p_limit: 5 }),
    sb.rpc("get_daily_progress"),
    sb.rpc("get_friends"),
    sb.rpc("get_incoming_challenges"),
    sb.from("direct_messages").select("id", { count: "exact", head: true })
      .eq("recipient_id", user.id).is("read_at", null),
  ]);

  if (!profile) redirect("/auth/login");

  // Dock badge: pending friend requests + battle invites + unread DMs.
  const friendsBadge =
    (friends ?? []).filter((f: { relation: string }) => f.relation === "incoming").length +
    (incomingChallenges?.length ?? 0) +
    (unreadCount ?? 0);

  return (
    <LobbyClient
      profile={profile}
      recentMatches={recentMatches ?? []}
      dailyProgress={dailyProgress ?? { matches_today: 0, wins_today: 0 }}
      friendsBadge={friendsBadge}
    />
  );
}
