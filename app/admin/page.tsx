import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AdminClient from "./admin-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  // is_admin isn't in generated types yet (migration pending) — cast to read it.
  if (!profile || !(profile as { is_admin?: boolean }).is_admin) redirect("/lobby");

  return <AdminClient />;
}
