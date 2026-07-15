"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Swords, Target, Eye, Trophy, Users, Settings } from "lucide-react";
import { NinjatestLogo, NinjaLogo } from "@/components/ninja-logo";
import { useOnlineCount } from "@/lib/hooks/use-online-count";
import { createClient } from "@/lib/supabase/client";
import { openNinjaCoach } from "@/lib/ninja";

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

const LINKS = [
  { href: "/lobby", label: "Arena", icon: Swords },
  { href: "/practice", label: "Practice", icon: Target },
  { href: "/spectate", label: "Spectate", icon: Eye },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/friends", label: "Friends", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppNav() {
  const pathname = usePathname();
  if (!SHOW.some((r) => r.test(pathname))) return null;
  return <AppNavInner pathname={pathname} />;
}

function AppNavInner({ pathname }: { pathname: string }) {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  return (
    <nav className="sticky top-0 z-40 border-b border-[#1c1a24] bg-[#120F17]/80 backdrop-blur-sm px-4 py-3">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
        <Link href="/lobby" aria-label="Ninjatest home" className="shrink-0">
          <NinjatestLogo />
        </Link>

        <div className="flex items-center gap-3 sm:gap-5 overflow-x-auto">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={`flex items-center gap-1.5 text-sm font-medium transition-colors ${
                  active ? "text-[#06d6a0]" : "text-[#7ab5cc] hover:text-white"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
          <button
            onClick={openNinjaCoach}
            aria-label="Ask Ninja"
            className="flex items-center gap-1.5 text-sm font-semibold text-[#06d6a0] hover:brightness-110 transition"
          >
            <NinjaLogo color="#06d6a0" className="w-[18px] h-[18px] shrink-0" />
            <span className="hidden sm:inline">Ask Ninja</span>
          </button>
        </div>

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
