import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileClient from "./profile-client";

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();

  const [
    { data: { user } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { data },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { data: rm },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { data: ss },
  ] = await Promise.all([
    supabase.auth.getUser(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_profile", { p_username: username }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_profile_matches", { p_username: username, p_limit: 20 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_section_stats", { p_username: username }),
  ]);

  if (!data) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileData = data as any;
  const isOwn = user?.id === profileData?.profile?.id;

  return (
    <ProfileClient
      profileData={profileData}
      isOwnProfile={isOwn}
      recentMatches={rm ?? []}
      sectionStats={ss ?? []}
    />
  );
}
