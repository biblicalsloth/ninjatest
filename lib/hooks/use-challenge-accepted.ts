"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Host-side watch: poll the caller's own challenge row until accept_challenge
// stamps match_id, then route into the match. Polling, not realtime —
// `challenges` is not in the supabase_realtime publication, and a 3s cadence
// is plenty inside the 15-minute code window.
export function useChallengeAccepted(code: string | null) {
  const router = useRouter();

  useEffect(() => {
    if (!code) return;
    const supabase = createClient();
    let stopped = false;
    const id = setInterval(async () => {
      const { data } = await supabase
        .from("challenges")
        .select("match_id")
        .eq("code", code)
        .not("match_id", "is", null)
        .maybeSingle();
      const matchId = (data as { match_id: string | null } | null)?.match_id;
      if (matchId && !stopped) {
        stopped = true;
        clearInterval(id);
        router.push(`/match/${matchId}`);
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [code, router]);
}
