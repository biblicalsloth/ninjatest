import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileClient from "./profile-client";

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc("get_profile", { p_username: username });
  if (!data) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileData = data as any;

  const { data: { user } } = await supabase.auth.getUser();

  return (
    <ProfileClient
      profileData={profileData}
      isOwnProfile={user?.id === profileData?.profile?.id}
    />
  );
}
