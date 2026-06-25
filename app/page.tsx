import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LandingClient from "./landing-client";

export default async function RootPage() {
  if (process.env.NEXT_PUBLIC_APP_MODE !== "waitlist") {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) redirect("/lobby");
  }

  return <LandingClient />;
}
