"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NinjaCoach } from "@/components/ninja-coach";
import { createClient } from "@/lib/supabase/client";

/*
 * Global mount for the Ninja Coach — one instance for the whole authed app.
 * Shown on nav-visible routes MINUS /queue (handoff screen) and /result
 * (already has NinjaPill floating bottom-right; don't stack two pills).
 * /spectate$ matches exactly so the [matchId] viewer stays excluded.
 * Authed-only: no LLM surface for anonymous visitors.
 */
const SHOW = [
  /^\/lobby/,
  /^\/practice/,
  /^\/spectate$/,
  /^\/leaderboard/,
  /^\/friends/,
  /^\/settings/,
  /^\/profile\//,
];

export function NinjaCoachMount() {
  const pathname = usePathname();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  if (!userId) return null;
  if (!SHOW.some((r) => r.test(pathname))) return null;
  return <NinjaCoach />;
}
