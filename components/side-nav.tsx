"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Home,
  Users,
  Eye,
  Trophy,
  Settings,
  Shield,
  LogOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { NinjaLogo } from "@/components/ninja-logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";

/*
 * Persistent floating dock, mounted once in the root layout so it survives
 * every route change (App Router keeps the layout mounted — no remount, no
 * flash). That makes per-screen "Back" arrows redundant. Allowlist keeps it
 * off the live match + spectate viewer (distraction-free) and auth/landing.
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
  /^\/plan/,
  /^\/c\//,
  /^\/result\//,
  /^\/ninja/,
];

interface Me {
  id: string;
  username: string;
  avatar_url: string | null;
  is_admin: boolean;
}

export function SideNav() {
  const pathname = usePathname();
  const show = SHOW.some((r) => r.test(pathname));
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id;
      if (!uid) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: row } = await (supabase as any)
        .from("profiles")
        .select("id, username, avatar_url, is_admin")
        .eq("id", uid)
        .single();
      if (!cancelled && row) setMe(row as Me);
    });
    return () => {
      cancelled = true;
    };
  }, [show]);

  if (!show) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed left-6 top-1/2 -translate-y-1/2 z-50 flex flex-col items-start gap-1 sm:gap-2 rounded-[1.75rem] px-2 py-3
        bg-gradient-to-b from-[#0be4ad] to-[#06d6a0] border border-[#3af0c8]/40
        shadow-[0_24px_60px_-12px_rgba(6,214,160,0.55),0_8px_20px_-6px_rgba(0,0,0,0.6)]
        backdrop-blur-sm"
    >
      <DockItem href="/lobby" label="Home" icon={<Home size={20} />} pathname={pathname} />
      <DockItem href="/friends" label="Friends" icon={<Users size={20} />} pathname={pathname} />
      <DockItem href="/spectate" label="Spectate" icon={<Eye size={20} />} pathname={pathname} />
      <DockItem href="/leaderboard" label="Leaderboard" icon={<Trophy size={20} />} pathname={pathname} />
      <DockItem href="/ninja" label="Ninja AI" icon={<NinjaLogo color="#073b4c" className="w-5 h-5" />} pathname={pathname} />
      <DockItem href="/settings" label="Settings" icon={<Settings size={20} />} pathname={pathname} />
      {me?.is_admin && <DockItem href="/admin" label="Admin" icon={<Shield size={20} />} pathname={pathname} />}

      {me && (
        <>
          <DockButton onClick={handleSignOut} label="Sign out" icon={<LogOut size={20} />} />
          <Link
            href={`/profile/${me.username}`}
            title="Profile"
            className="group relative mt-0.5 ml-1 transition-transform duration-150 hover:scale-125 hover:translate-x-1"
          >
            <Avatar className="w-9 h-9 ring-2 ring-[#073b4c]/30">
              <AvatarImage src={me.avatar_url ?? undefined} />
              <AvatarFallback className="bg-[#073b4c] text-[#06d6a0] text-xs font-bold">
                {me.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <DockTip>Profile</DockTip>
          </Link>
        </>
      )}
    </nav>
  );
}

async function handleSignOut() {
  await signOut();
  // Hard replace: drops the history entry so Back can't return to the authed
  // app, and forces a server round-trip past middleware.
  window.location.replace("/auth/login");
}

// Kokonut UI toolbar motion (kokonutui/toolbar.tsx): active pill expands and
// reveals its label with a bounce-0 spring; selection derives from the route.
const dockTransition = { type: "spring", bounce: 0, duration: 0.4 } as const;

function DockItem({ href, label, icon, pathname }: { href: string; label: string; icon: React.ReactNode; pathname: string }) {
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link href={href} title={label} className="group relative">
      <motion.span
        className={cn(
          "flex items-center h-11 rounded-full text-[#073b4c] transition-colors duration-300",
          active ? "bg-[#073b4c]/15" : "hover:bg-[#073b4c]/10"
        )}
        initial={false}
        animate={{
          gap: active ? "0.5rem" : "0rem",
          paddingLeft: active ? "1rem" : "0.75rem",
          paddingRight: active ? "1rem" : "0.75rem",
        }}
        whileHover={active ? undefined : { scale: 1.15 }}
        transition={dockTransition}
      >
        {icon}
        <AnimatePresence initial={false}>
          {active && (
            <motion.span
              className="overflow-hidden whitespace-nowrap text-sm font-medium"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "auto", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={dockTransition}
            >
              {label}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.span>
      {!active && <DockTip>{label}</DockTip>}
    </Link>
  );
}

function DockButton({ onClick, label, icon }: { onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="group relative flex items-center justify-center w-11 h-11 rounded-full text-[#073b4c] transition-transform duration-150 hover:scale-125 hover:translate-x-1"
    >
      {icon}
      <DockTip>{label}</DockTip>
    </button>
  );
}

function DockTip({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded-md bg-[#111111] px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity">
      {children}
    </span>
  );
}
