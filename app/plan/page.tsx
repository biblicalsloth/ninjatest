export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { StudyPlan } from "@/lib/ai/model";
import PlanClient from "./plan-client";

// Reads the cached plan server-side, so opening /plan costs one RPC and never
// an LLM call. Generation is the client's explicit button (POST /api/ninja/plan).
export default async function PlanPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc("get_ninja_study_plan", { p_week_start: null });
  const row = (Array.isArray(data) ? data[0] : null) as
    { week_start: string; plan: StudyPlan | null; regens: number } | null;

  return (
    <PlanClient
      initialPlan={row?.plan ?? null}
      weekStart={row?.week_start ?? null}
      initialRegens={row?.regens ?? 0}
    />
  );
}
