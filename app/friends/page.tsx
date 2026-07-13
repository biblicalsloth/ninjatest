import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FriendsClient from "./friends-client";

export const dynamic = "force-dynamic";

export default async function FriendsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return <FriendsClient myId={user.id} />;
}
