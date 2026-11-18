import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ArenaClient from "./arena-client";

export const dynamic = "force-dynamic";

export default async function ArenaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?next=/arena");
  return <ArenaClient />;
}
