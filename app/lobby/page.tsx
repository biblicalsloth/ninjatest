import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEV_BYPASS, DEV_PROFILE } from "@/lib/dev-user";
import LobbyClient from "./lobby-client";

export default async function LobbyPage() {
  if (DEV_BYPASS) {
    return <LobbyClient profile={DEV_PROFILE} recentMatches={[]} />;
  }

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
  const { data: recentMatches } = await (supabase as any).rpc("get_recent_matches", { p_limit: 5 });

  return <LobbyClient profile={profile} recentMatches={recentMatches ?? []} />;
}
