import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileClient from "./profile-client";

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc("get_profile", { p_username: username });
  if (!data) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileData = data as any;
  const isOwn = user?.id === profileData?.profile?.id;

  // Fetch recent matches only for own profile (RPC uses auth.uid())
  let recentMatches: unknown[] = [];
  if (isOwn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rm } = await (supabase as any).rpc("get_recent_matches", { p_limit: 10 });
    recentMatches = rm ?? [];
  }

  return (
    <ProfileClient
      profileData={profileData}
      isOwnProfile={isOwn}
      recentMatches={recentMatches}
    />
  );
}
