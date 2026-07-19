"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Zap,
  Users,
  Trophy,
  Flame,
  Check,
  Circle,
  Eye,
  ChevronRight,
  Target,
  Bot,
} from "lucide-react";
import { NinjaDailyFocus } from "@/components/ninja-daily-focus";
import { NinjatestLogo } from "@/components/ninja-logo";
import { useOnlineCount } from "@/lib/hooks/use-online-count";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChallengeDialog } from "@/components/challenge-dialog";
import type { Profile } from "@/lib/supabase/types";
import { cn, getWinRate } from "@/lib/utils";
import { getLeague } from "@/lib/leagues";

interface DailyProgress {
  matches_today: number;
  wins_today: number;
}

interface Props {
  profile: Profile;
  dailyProgress: DailyProgress;
}

const DAILY_TASKS = [
  { key: "match" as const, label: "Play 1 match today", target: 1, get: (p: DailyProgress) => p.matches_today },
  { key: "wins" as const, label: "Win 2 matches today", target: 2, get: (p: DailyProgress) => p.wins_today },
];

export default function LobbyClient({ profile, dailyProgress }: Props) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [startingBot, setStartingBot] = useState(false);
  const [showChallenge, setShowChallenge] = useState(false);
  const displayName = profile.display_name ?? profile.username;

  async function handleFindMatch() {
    setJoining(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("join_queue");
    if (error) {
      toast.error("Failed to join queue: " + error.message);
      setJoining(false);
      return;
    }
    router.push("/queue");
  }

  async function handlePlayBot() {
    if (startingBot) return;
    setStartingBot(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("match_with_bot");
    if (error || !data) {
      toast.error("Bot unavailable right now — try again");
      setStartingBot(false);
      return;
    }
    router.push(`/match/${data}`);
  }

  const winRate = getWinRate(profile.wins, profile.matches_played);
  const league = getLeague(profile.elo);

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      {/* Header — brand mark leads top-left, greeting stacked below it. Shares
          the grid's container so both align to the same gutters. The greeting
          lives here, not in the left column: keeping it inside <section> pushed
          the first card ~90px below the rail card and desynced the two column
          tops. */}
      <header className="max-w-5xl mx-auto px-4 pt-6">
        <div className="flex items-center justify-between gap-3">
          <NinjatestLogo />
          <OnlinePill userId={profile.id} />
        </div>
        <div className="min-w-0 mt-8">
          <h1 className="font-pixel text-2xl break-words">
            Welcome, <span className="text-[#06d6a0]">{displayName}</span>
          </h1>
          <p className="font-pixel text-[#7ab5cc] text-sm mt-2">Play</p>
          <p className="text-[#4a8fa8] text-sm">Pick a mode to enter a battle.</p>
        </div>
      </header>

      {/* Dashboard grid: main matchmaking hub + side rail. Default align-items
          (stretch) is load-bearing — items-start would collapse the aside to
          content height and kill its lg:sticky track. */}
      <main className="max-w-5xl mx-auto px-4 pt-8 pb-32 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left / center — matchmaking is the home state */}
        <section className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Ranked 1v1 — primary */}
            <button
              onClick={handleFindMatch}
              disabled={joining}
              className="group relative text-left rounded-2xl p-5 bg-gradient-to-br from-[#06d6a0] to-[#05b088] text-[#073b4c] disabled:opacity-70 overflow-hidden transition-transform hover:-translate-y-0.5"
            >
              <div className="flex items-center justify-between">
                <Zap size={22} className="shrink-0" />
                <ChevronRight size={18} className="opacity-60 group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg">Ranked 1v1</div>
                <div className="text-sm text-[#073b4c]/80">
                  {joining ? "Joining queue…" : "Mixed 3·3·3 · ELO rated"}
                </div>
              </div>
            </button>

            {/* Challenge a friend */}
            <button
              onClick={() => setShowChallenge(true)}
              className="group text-left rounded-2xl p-5 bg-[#111111] border border-[#1c1a24] hover:border-[#06d6a0]/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Users size={22} className="text-[#06d6a0]" />
                <ChevronRight size={18} className="text-[#4a8fa8] group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg text-white">Challenge a Friend</div>
                <div className="text-sm text-[#7ab5cc]">Invite by code · rated or section mode</div>
              </div>
            </button>

            {/* Practice */}
            <Link
              href="/practice"
              className="group text-left rounded-2xl p-5 bg-[#111111] border border-[#1c1a24] hover:border-[#06d6a0]/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Target size={22} className="text-[#06d6a0]" />
                <ChevronRight size={18} className="text-[#4a8fa8] group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg text-white">Practice</div>
                <div className="text-sm text-[#7ab5cc]">Solo drill · targets your weak sections</div>
              </div>
            </Link>

            {/* Vs Ninja Bot */}
            <button
              onClick={handlePlayBot}
              disabled={startingBot}
              className="group text-left rounded-2xl p-5 bg-[#111111] border border-[#1c1a24] hover:border-[#06d6a0]/40 transition-colors disabled:opacity-70"
            >
              <div className="flex items-center justify-between">
                <Bot size={22} className="text-[#06d6a0]" />
                <ChevronRight size={18} className="text-[#4a8fa8] group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg text-white">Vs Ninja Bot</div>
                <div className="text-sm text-[#7ab5cc]">
                  {startingBot ? "Starting…" : "Instant match · unrated · adapts to your ELO"}
                </div>
              </div>
            </button>

            {/* Spectate */}
            <Link
              href="/spectate"
              className="group text-left rounded-2xl p-5 bg-[#111111] border border-[#1c1a24] hover:border-[#06d6a0]/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Eye size={22} className="text-[#7ab5cc]" />
                <ChevronRight size={18} className="text-[#4a8fa8] group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg text-white">Spectate</div>
                <div className="text-sm text-[#7ab5cc]">Watch live matches</div>
              </div>
            </Link>

            {/* Leaderboard */}
            <Link
              href="/leaderboard"
              className="group text-left rounded-2xl p-5 bg-[#111111] border border-[#1c1a24] hover:border-[#ffd166]/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Trophy size={22} className="text-[#ffd166]" />
                <ChevronRight size={18} className="text-[#4a8fa8] group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-8">
                <div className="font-pixel text-lg text-white">Leaderboard</div>
                <div className="text-sm text-[#7ab5cc]">Season top 100</div>
              </div>
            </Link>
          </div>

        </section>

        {/* Right rail — profile snapshot + stats + dailies, boxed off from the play area */}
        <aside>
          <div className="lg:sticky lg:top-6 rounded-2xl border border-white/10 bg-[#111111] p-5 space-y-5">
            {/* Profile header */}
            <div className="flex items-center gap-4">
              <Avatar className="w-14 h-14">
                <AvatarImage src={profile.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#120F17] text-[#06d6a0] font-bold text-lg">
                  {profile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-white truncate">{displayName}</p>
                  <Badge
                    variant="outline"
                    className="shrink-0"
                    style={{
                      color: league.color,
                      borderColor: `${league.color}4d`,
                      backgroundColor: `${league.color}1a`,
                    }}
                  >
                    {league.name}
                  </Badge>
                </div>
                <p className="text-[#7ab5cc] text-sm">@{profile.username}</p>
                {profile.current_streak >= 3 && (
                  <div className="flex items-center gap-1 mt-1">
                    <Flame size={12} className="text-[#ffd166]" />
                    <span className="text-[#ffd166] text-xs font-semibold">{profile.current_streak} streak</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
              <StatCard label="ELO" value={profile.elo.toString()} gold />
              <StatCard label="Win rate" value={winRate} accent />
              <StatCard label="Peak" value={profile.peak_elo.toString()} gold />
            </div>

            {/* Daily challenges */}
            <div className="border-t border-white/10 pt-5">
              <h2 className="font-pixel text-[#7ab5cc] text-sm mb-3">Today</h2>
              <div className="space-y-2.5">
                {DAILY_TASKS.map((t) => {
                  const value = t.get(dailyProgress);
                  const done = value >= t.target;
                  return (
                    <div key={t.key} className="flex items-center gap-2.5">
                      {done ? (
                        <Check size={16} className="text-[#06d6a0] shrink-0" />
                      ) : (
                        <Circle size={16} className="text-[#4a8fa8] shrink-0" />
                      )}
                      <span className={cn("text-sm", done ? "text-[#06d6a0]" : "text-[#7ab5cc]")}>
                        {t.label}
                      </span>
                      <span className="text-[#4a8fa8] text-xs ml-auto">
                        {Math.min(value, t.target)}/{t.target}
                      </span>
                    </div>
                  );
                })}
                <NinjaDailyFocus />
              </div>
            </div>
          </div>
        </aside>
      </main>

      <ChallengeDialog open={showChallenge} onOpenChange={setShowChallenge} />
    </div>
  );
}

// The app's only online-count surface — the dock pill is gone by design.
// One WS per authed lobby visitor, deduped across tabs by userId.
function OnlinePill({ userId }: { userId: string }) {
  const count = useOnlineCount(userId);
  if (count === null) return null;
  return (
    <div
      title={`${count} online now`}
      className="flex shrink-0 items-center gap-2 rounded-full border border-[#1c1a24] bg-[#111111] px-3 py-1.5"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#06d6a0] opacity-50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#06d6a0]" />
      </span>
      <span className="text-xs font-semibold text-white">{count}</span>
      <span className="text-xs text-[#7ab5cc]">online</span>
    </div>
  );
}

function StatCard({ label, value, accent, gold }: { label: string; value: string; accent?: boolean; gold?: boolean }) {
  return (
    <div className="bg-[#181818] rounded-xl p-4 text-center">
      <div className={`text-xl font-bold ${gold ? "text-[#ffd166]" : accent ? "text-[#06d6a0]" : "text-white"}`}>{value}</div>
      <div className="text-[#7ab5cc] text-xs mt-0.5">{label}</div>
    </div>
  );
}

