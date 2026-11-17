"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Home,
  Target,
  Trophy,
  Eye,
  Users,
  CalendarDays,
  History,
  FileText,
  Settings,
  LogOut,
  ChevronLeft,
  Menu,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { NinjaLogo, NinjatestLogo } from "@/components/ninja-logo";
import { NinjaMascot } from "@/components/ninja-mascot";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SIDENAV_STORE_KEY, SIDENAV_COLLAPSED_ATTR } from "@/lib/sidenav";

/*
 * Persistent SaaS sidebar, mounted once in the root layout so it survives
 * every route change. Allowlist keeps it off the live match + spectate viewer
 * (distraction-free) and auth/landing. /spectate matches exactly so
 * /spectate/[matchId] stays excluded.
 *
 * Content offset is pure CSS: the <aside> carries data-sidenav, and
 * globals.css sets --nav-w on body via :has(), padding the page clear of it.
 * Fixed full-screen pages (/ninja) read var(--nav-w) for their left edge.
 *
 * Desktop is a floating black panel inset 12px from the viewport, with a round
 * collapse knob straddling its right edge. Width and the body's padding-left
 * share one CSS transition (--nav-ease in globals.css) so the content gutter
 * never drifts from the panel mid-animation — a JS spring on the width alone
 * would race the CSS padding.
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

const MAIN = [
  { href: "/lobby", label: "Home", icon: <Home size={18} /> },
  { href: "/practice", label: "Practice", icon: <Target size={18} /> },
  { href: "/leaderboard", label: "Leaderboard", icon: <Trophy size={18} /> },
  { href: "/spectate", label: "Spectate", icon: <Eye size={18} /> },
  { href: "/friends", label: "Friends", icon: <Users size={18} /> },
  { href: "/plan", label: "Study Plan", icon: <CalendarDays size={18} /> },
];

const NINJA = [
  { href: "/ninja", label: "Ask Ninja", icon: <NinjaMascot size={20} animated={false} />, exact: true },
  { href: "/ninja/history", label: "History", icon: <History size={18} /> },
  { href: "/ninja/solve", label: "Solve a Paper", icon: <FileText size={18} /> },
];

const STORE_KEY = SIDENAV_STORE_KEY;
const COLLAPSED_ATTR = SIDENAV_COLLAPSED_ATTR;

interface Me {
  id: string;
  username: string;
  avatar_url: string | null;
}

export function SideNav() {
  const pathname = usePathname();
  const show = SHOW.some((r) => r.test(pathname));
  const [me, setMe] = useState<Me | null>(null);
  // No-flash collapse: SIDENAV_INIT_SCRIPT (root layout <head>) sets
  // html[data-nav-collapsed] from localStorage before first paint, and
  // globals.css honours it until hydration. The attribute is the source of
  // truth; this state just mirrors it after mount. (A cookie read in the
  // layout would make every ISR page dynamic.)
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(document.documentElement.hasAttribute(COLLAPSED_ATTR));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDrawer(false), [pathname]);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id;
      if (!uid) return;
      const { data: row } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .eq("id", uid)
        .single();
      if (!cancelled && row) setMe(row as Me);
    });
    return () => {
      cancelled = true;
    };
  }, [show]);

  if (!show) return null;

  const toggle = () => {
    const next = !collapsed;
    document.documentElement.toggleAttribute(COLLAPSED_ATTR, next);
    try { localStorage.setItem(STORE_KEY, next ? "1" : "0"); } catch {}
    setCollapsed(next);
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        data-sidenav={collapsed ? "collapsed" : "expanded"}
        className={cn(
          "nav-ease fixed top-3 bottom-3 left-3 z-40 hidden md:flex flex-col rounded-[28px] bg-black shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] transition-[width]",
          collapsed ? "w-[4.5rem]" : "w-60"
        )}
      >
        <button
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-[26px] z-10 flex h-6 w-6 items-center justify-center rounded-full bg-[#06d6a0] text-[#17131C] shadow-[0_0_0_4px_#120F17] transition-transform hover:scale-110 active:scale-95"
        >
          <ChevronLeft size={14} strokeWidth={2.5} className={cn("nav-ease transition-transform", collapsed && "rotate-180")} />
        </button>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px]">
          <NavBody pathname={pathname} me={me} collapsed={collapsed} />
        </div>
      </aside>

      {/* Mobile top bar + drawer */}
      <div data-sidenav-mobile className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-white/10 bg-black px-4 md:hidden">
        <Link href="/lobby"><NinjatestLogo /></Link>
        <button onClick={() => setDrawer(true)} aria-label="Open menu" className="rounded-lg p-2 text-[#c5e8f0] hover:bg-white/5">
          <Menu size={20} />
        </button>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-50 flex md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <aside className="relative z-10 m-3 flex w-64 flex-col rounded-[28px] bg-black" onClick={(e) => e.stopPropagation()}>
            <NavBody pathname={pathname} me={me} collapsed={false} onClose={() => setDrawer(false)} />
          </aside>
        </div>
      )}
    </>
  );
}

function NavBody({
  pathname,
  me,
  collapsed,
  onClose,
}: {
  pathname: string;
  me: Me | null;
  collapsed: boolean;
  onClose?: () => void;
}) {
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      <div className={cn("flex h-20 shrink-0 items-center px-5", collapsed ? "justify-center px-0" : "justify-between")}>
        <Link href="/lobby" aria-label="Home">
          {collapsed ? <NinjaLogo color="#06d6a0" className="h-6 w-6" /> : <NinjatestLogo />}
        </Link>
        {onClose && (
          <button onClick={onClose} aria-label="Close menu" className="rounded-lg p-2 text-[#7ab5cc] hover:bg-white/5">
            <X size={18} />
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
        {!collapsed && <p className="mb-2 px-3 text-[11px] text-white/40">General</p>}
        <ul className="space-y-1">
          {MAIN.map((it) => (
            <NavItem key={it.href} {...it} active={isActive(it.href)} collapsed={collapsed} />
          ))}
        </ul>
        {collapsed ? (
          <div className="mx-3 my-4 h-px bg-white/10" />
        ) : (
          <p className="mt-6 mb-2 px-3 text-[11px] text-white/40">Ninja AI</p>
        )}
        <ul className="space-y-1">
          {NINJA.map((it) => (
            <NavItem key={it.href} {...it} active={isActive(it.href, it.exact)} collapsed={collapsed} />
          ))}
        </ul>
      </nav>

      <div className="shrink-0 space-y-1 border-t border-white/10 px-3 py-3">
        <ul>
          <NavItem href="/settings" label="Settings" icon={<Settings size={18} />} active={isActive("/settings")} collapsed={collapsed} />
        </ul>
        {me && (
          <>
            <Link
              href={`/profile/${me.username}`}
              title={collapsed ? me.username : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/5",
                isActive(`/profile/${me.username}`) && "bg-[#06d6a0]/10",
                collapsed && "justify-center px-0"
              )}
            >
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarImage src={me.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#073b4c] text-[#06d6a0] text-[10px] font-bold">
                  {me.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {!collapsed && <span className="truncate text-sm text-[#c5e8f0]">{me.username}</span>}
            </Link>
            <button
              onClick={handleSignOut}
              title={collapsed ? "Sign out" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-[#7ab5cc] transition hover:bg-white/5 hover:text-[#ef476f]",
                collapsed && "justify-center px-0"
              )}
            >
              <LogOut size={18} className="shrink-0" />
              {!collapsed && "Sign out"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function NavItem({ href, label, icon, active, collapsed }: { href: string; label: string; icon: React.ReactNode; active: boolean; collapsed: boolean }) {
  return (
    <li className="relative">
      {/* One shared bar that springs between items on route change (ref: the
          pink tick left of the active item). */}
      {active && (
        <motion.span
          layoutId="sidenav-active"
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[#06d6a0]"
        />
      )}
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        title={collapsed ? label : undefined}
        className={cn(
          "flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors",
          active ? "text-[#06d6a0] font-medium" : "text-white/75 hover:bg-white/[0.06] hover:text-white",
          collapsed && "justify-center px-0"
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.span
              key="label"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0, transition: { delay: 0.08, duration: 0.2 } }}
              exit={{ opacity: 0, x: -6, transition: { duration: 0.1 } }}
              className="truncate"
            >
              {label}
            </motion.span>
          )}
        </AnimatePresence>
      </Link>
    </li>
  );
}

async function handleSignOut() {
  await signOut();
  // Hard replace: drops the history entry so Back can't return to the authed
  // app, and forces a server round-trip past middleware.
  window.location.replace("/auth/login");
}

