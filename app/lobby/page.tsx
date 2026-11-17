import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { StudyPlan } from "@/lib/ai/model";
import LobbyClient, { type RecentMatch, type SectionStat } from "./lobby-client";

export default async function LobbyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  // All reads are cached/cheap: the study plan is a stored row (never an LLM
  // call on page load — generation is the timeline's explicit button).
  const [
    { data: dailyProgress },
    { data: sectionStats },
    { data: recent },
    { data: history },
    { data: planRows },
  ] = await Promise.all([
    sb.rpc("get_daily_progress"),
    sb.rpc("get_section_stats", { p_username: profile.username }),
    sb.rpc("get_profile_matches", { p_username: profile.username, p_limit: 5 }),
    supabase
      .from("rating_history")
      .select("elo_after, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30),
    sb.rpc("get_ninja_study_plan", { p_week_start: null }),
  ]);

  const planRow = (Array.isArray(planRows) ? planRows[0] : null) as
    { week_start: string; plan: StudyPlan | null; regens: number } | null;

  return (
    <LobbyClient
      profile={profile}
      dailyProgress={dailyProgress ?? { matches_today: 0, wins_today: 0 }}
      sectionStats={(sectionStats ?? []) as SectionStat[]}
      recentMatches={(recent ?? []) as RecentMatch[]}
      eloCurve={(history ?? []).map((h) => h.elo_after).reverse()}
      plan={planRow?.plan ?? null}
      weekStart={planRow?.week_start ?? null}
      regens={planRow?.regens ?? 0}
    />
  );
}
