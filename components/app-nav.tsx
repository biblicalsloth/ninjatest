"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NinjatestLogo } from "@/components/ninja-logo";
import { useOnlineCount } from "@/lib/hooks/use-online-count";
import { createClient } from "@/lib/supabase/client";

/*
 * Sticky app navbar, mounted once in the root layout.
 * Allowlist keeps it off the landing page (has its own nav), auth flows,
 * and — critically — the live match + spectate viewer, which stay
 * distraction-free. It reappears on /result and everywhere after.
 * /spectate matches exactly so /spectate/[matchId] stays excluded.
 */
const SHOW = [
  /^\/lobby/,
  /^\/queue/,
  /^\/leaderboard/,
  /^\/profile\//,
  /^\/spectate$/,
  /^\/settings/,
  /^\/friends/,
  /^\/practice/,
  /^\/c\//,
  /^\/result\//,
];

export function AppNav() {
  const pathname = usePathname();
  if (!SHOW.some((r) => r.test(pathname))) return null;
  return <AppNavInner />;
}

function AppNavInner() {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  return (
    <nav className="sticky top-0 z-40 border-b border-[#1c1a24] bg-[#120F17]/80 backdrop-blur-sm px-4 py-3">
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <Link href="/lobby" aria-label="Ninjatest home">
          <NinjatestLogo />
        </Link>
        {/* Presence WS only for authed users — anon views of public pages
            (leaderboard/profile ISR) must not open a channel per visitor. */}
        {userId && <OnlinePill userId={userId} />}
      </div>
    </nav>
  );
}

function OnlinePill({ userId }: { userId: string }) {
  const onlineCount = useOnlineCount(userId);
  if (onlineCount === null) return null;
  return (
    <div className="flex items-center gap-1.5 bg-[#06d6a0]/10 border border-[#06d6a0]/20 rounded-full px-2.5 py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-[#06d6a0] animate-pulse" />
      <span className="text-[#06d6a0] text-xs font-medium">{onlineCount} online</span>
    </div>
  );
}
