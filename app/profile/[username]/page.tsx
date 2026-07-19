import { notFound } from "next/navigation";
import { createPublicClient } from "@/lib/supabase/server";
import ProfileClient from "./profile-client";
import { Enter } from "@/components/enter";

// Public, crawlable page. Cache at the edge and revalidate every 60s instead of
// re-running 3 RPCs on every visitor/bot hit. No auth cookie is read here, so
// the route stays statically renderable; "is this my profile" is resolved
// client-side in ProfileClient.
export const revalidate = 60;

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = createPublicClient();

  const [{ data }, { data: rm }, { data: ss }, { data: ds }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_profile", { p_username: username }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_profile_matches", { p_username: username, p_limit: 20 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_section_stats", { p_username: username }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_profile_deep_stats", { p_username: username }),
  ]);

  if (!data) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileData = data as any;

  return (
    <Enter>
      <ProfileClient
        profileData={profileData}
        recentMatches={rm ?? []}
        sectionStats={ss ?? []}
        deepStats={ds ?? null}
      />
    </Enter>
  );
}
