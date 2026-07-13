import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OnboardingClient from "./onboarding-client";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (supabase as any)
    .from("profiles")
    .select("username, display_name, onboarding_completed")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/auth/login");
  if (profile.onboarding_completed) redirect("/lobby");

  return (
    <OnboardingClient
      initialName={profile.display_name ?? ""}
      initialUsername={profile.username}
    />
  );
}
