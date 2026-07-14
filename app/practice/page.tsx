import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PracticeClient from "./practice-client";

export default async function PracticePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <PracticeClient />;
}
