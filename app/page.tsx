import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LandingClient from "./landing-client";

export default async function RootPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/lobby");

  return <LandingClient />;
}
