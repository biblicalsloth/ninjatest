import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SpectateClient from "./spectate-client";
import { Enter } from "@/components/enter";

interface Props {
  params: Promise<{ matchId: string }>;
}

export default async function SpectateMatchPage({ params }: Props) {
  const { matchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/login?next=/spectate/${matchId}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc("get_spectator_match", { p_match_id: matchId });
  const match = data?.[0];
  if (!match) redirect("/spectate");

  return (
    <Enter>
      <SpectateClient initialMatch={match} />
    </Enter>
  );
}
