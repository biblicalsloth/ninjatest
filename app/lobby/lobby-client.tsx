"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Zap, Users, Trophy, LogOut, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChallengeDialog } from "@/components/challenge-dialog";
import type { Profile } from "@/lib/supabase/types";
import { formatPoints, getWinRate } from "@/lib/utils";

interface RecentMatch {
  match_id: string;
  opponent: string;
  opponent_avatar: string | null;
  my_score: number;
  opp_score: number;
  result: "win" | "loss" | "draw";
  elo_delta: number;
  played_at: string;
}

interface Props {
  profile: Profile;
  recentMatches: RecentMatch[];
}

export default function LobbyClient({ profile, recentMatches }: Props) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [showChallenge, setShowChallenge] = useState(false);

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

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  const winRate = getWinRate(profile.wins, profile.matches_played);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Nav */}
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#06d6a0] flex items-center justify-center">
              <span className="text-[#073b4c] font-bold text-sm">N</span>
            </div>
            <span className="font-semibold text-white tracking-tight">Ninjatest</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href={`/profile/${profile.username}`}>
              <Avatar className="w-8 h-8 cursor-pointer">
                <AvatarImage src={profile.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#111111] text-[#06d6a0] text-xs font-bold">
                  {profile.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </Link>
            <button
              onClick={handleSignOut}
              className="text-[#7ab5cc] hover:text-white transition-colors"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Profile card */}
        <div className="bg-[#111111] rounded-xl p-5 flex items-center gap-4">
          <Avatar className="w-14 h-14">
            <AvatarImage src={profile.avatar_url ?? undefined} />
            <AvatarFallback className="bg-black text-[#06d6a0] font-bold text-lg">
              {profile.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-white truncate">{profile.display_name ?? profile.username}</p>
            <p className="text-[#7ab5cc] text-sm">@{profile.username}</p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold text-[#ffd166]">{profile.elo}</div>
            <div className="text-[#7ab5cc] text-xs">ELO rating</div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Matches" value={profile.matches_played.toString()} />
          <StatCard label="Win rate" value={winRate} accent />
          <StatCard label="Peak ELO" value={profile.peak_elo.toString()} gold />
        </div>

        {/* Primary actions */}
        <div className="space-y-3">
          <Button
            onClick={handleFindMatch}
            disabled={joining}
            className="w-full h-14 bg-[#06d6a0] text-[#073b4c] font-bold text-base rounded-full hover:bg-[#05b088] transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            <Zap size={18} />
            {joining ? "Joining queue…" : "Find Match"}
          </Button>

          <Button
            onClick={() => setShowChallenge(true)}
            variant="outline"
            className="w-full h-12 border-[#333333] text-white font-semibold rounded-full hover:bg-[#111111] transition-colors flex items-center gap-2"
          >
            <Users size={16} />
            Challenge a Friend
          </Button>

          <div className="grid grid-cols-2 gap-3">
            <Link href="/leaderboard">
              <Button
                variant="ghost"
                className="w-full h-11 text-[#c5e8f0] hover:text-white hover:bg-[#111111] rounded-lg flex items-center gap-2"
              >
                <Trophy size={16} />
                Leaderboard
              </Button>
            </Link>
            <Link href={`/profile/${profile.username}`}>
              <Button
                variant="ghost"
                className="w-full h-11 text-[#c5e8f0] hover:text-white hover:bg-[#111111] rounded-lg flex items-center gap-2"
              >
                <User size={16} />
                My Profile
              </Button>
            </Link>
          </div>
        </div>

        {/* Recent matches */}
        {recentMatches.length > 0 && (
          <div>
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-3">Recent matches</h2>
            <div className="space-y-2">
              {recentMatches.map((m) => (
                <div
                  key={m.match_id}
                  className="bg-[#111111] rounded-lg px-4 py-3 flex items-center gap-3"
                >
                  <Avatar className="w-8 h-8 shrink-0">
                    <AvatarImage src={m.opponent_avatar ?? undefined} />
                    <AvatarFallback className="bg-black text-[#06d6a0] text-xs font-bold">
                      {m.opponent.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{m.opponent}</p>
                    <p className="text-[#7ab5cc] text-xs">
                      {m.my_score} — {m.opp_score}
                    </p>
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <ResultBadge result={m.result} />
                    <p className={`text-xs font-medium ${m.elo_delta >= 0 ? "text-[#06d6a0]" : "text-[#ef476f]"}`}>
                      {formatPoints(m.elo_delta)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <ChallengeDialog open={showChallenge} onOpenChange={setShowChallenge} />
    </div>
  );
}

function StatCard({ label, value, accent, gold }: { label: string; value: string; accent?: boolean; gold?: boolean }) {
  return (
    <div className="bg-[#111111] rounded-xl p-4 text-center">
      <div className={`text-xl font-bold ${gold ? "text-[#ffd166]" : accent ? "text-[#06d6a0]" : "text-white"}`}>{value}</div>
      <div className="text-[#7ab5cc] text-xs mt-0.5">{label}</div>
    </div>
  );
}

function ResultBadge({ result }: { result: "win" | "loss" | "draw" }) {
  if (result === "win") return <Badge className="bg-[#06d6a0]/20 text-[#06d6a0] border-[#06d6a0]/30 text-xs px-2 py-0">W</Badge>;
  if (result === "loss") return <Badge className="bg-[#ef476f]/20 text-[#ef476f] border-[#ef476f]/30 text-xs px-2 py-0">L</Badge>;
  return <Badge className="bg-[#7ab5cc]/20 text-[#c5e8f0] border-[#7ab5cc]/30 text-xs px-2 py-0">D</Badge>;
}
