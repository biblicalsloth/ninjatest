"use client";

import Link from "next/link";
import { ArrowLeft, Trophy, Settings } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EloGraph } from "@/components/elo-graph";
import { cn, getWinRate, formatPoints } from "@/lib/utils";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profileData: any;
  isOwnProfile: boolean;
  recentMatches: unknown[];
}

export default function ProfileClient({ profileData, isOwnProfile, recentMatches }: Props) {
  const { profile, curve } = profileData;
  const winRate = getWinRate(profile.wins, profile.matches_played);
  const matches = recentMatches as RecentMatch[];

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/lobby" className="text-[#7ab5cc] hover:text-white transition-colors flex items-center gap-1.5 text-sm">
            <ArrowLeft size={14} />
            Back
          </Link>
          <div className="flex items-center gap-3">
            {isOwnProfile && (
              <Badge className="bg-[#06d6a0]/10 text-[#06d6a0] border-[#06d6a0]/30 text-xs">
                Your profile
              </Badge>
            )}
            {isOwnProfile && (
              <Link href="/settings" className="text-[#7ab5cc] hover:text-white transition-colors">
                <Settings size={16} />
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Profile header */}
        <div className="flex items-center gap-4">
          <Avatar className="w-20 h-20">
            <AvatarImage src={profile.avatar_url ?? undefined} />
            <AvatarFallback className="bg-[#111111] text-[#06d6a0] text-2xl font-bold">
              {profile.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h1 className="text-white text-xl font-bold truncate">
              {profile.display_name ?? profile.username}
            </h1>
            <p className="text-[#7ab5cc] text-sm">@{profile.username}</p>
            <div className="flex items-center gap-3 mt-2">
              <div>
                <span className="text-[#ffd166] font-bold text-xl">{profile.elo}</span>
                <span className="text-[#7ab5cc] text-xs ml-1">ELO</span>
              </div>
              <div className="w-px h-4 bg-[#2a7a9a]" />
              <div>
                <span className="text-white font-semibold">{profile.peak_elo}</span>
                <span className="text-[#7ab5cc] text-xs ml-1">Peak</span>
              </div>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="Played" value={profile.matches_played.toString()} />
          <StatBox label="Win rate" value={winRate} accent />
          <StatBox label="W / L" value={`${profile.wins}/${profile.losses}`} />
          <StatBox label="Draws" value={profile.draws.toString()} />
        </div>

        {/* ELO graph */}
        {curve.length > 1 ? (
          <div className="bg-[#111111] rounded-xl p-5">
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-4 flex items-center gap-1.5">
              <Trophy size={14} />
              Rating history
            </h2>
            <EloGraph data={curve} />
          </div>
        ) : (
          <div className="bg-[#111111] rounded-xl p-8 text-center">
            <p className="text-[#4a8fa8] text-sm">Play rated matches to see your ELO graph.</p>
          </div>
        )}

        {/* Recent rating changes */}
        {curve.length > 0 && (
          <div className="bg-[#111111] rounded-xl p-5">
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-3">Recent rating changes</h2>
            <div className="space-y-2">
              {[...curve].reverse().slice(0, 8).map((c: { elo: number; at: string; delta: number }, i: number) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-[#1a1a1a] last:border-0">
                  <div>
                    <span className="text-white text-sm font-medium">{c.elo}</span>
                    <span className="text-[#7ab5cc] text-xs ml-2">{new Date(c.at).toLocaleDateString()}</span>
                  </div>
                  <span className={cn("text-sm font-semibold", c.delta >= 0 ? "text-[#06d6a0]" : "text-[#ef476f]")}>
                    {formatPoints(c.delta)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Match history */}
        {matches.length > 0 && (
          <div className="bg-[#111111] rounded-xl p-5">
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-3">Recent matches</h2>
            <div className="space-y-2">
              {matches.map((m) => {
                const inner = (
                  <div className={cn(
                    "flex items-center gap-3 py-2 border-b border-[#1a1a1a] last:border-0 transition-opacity",
                    isOwnProfile && "hover:opacity-80 cursor-pointer"
                  )}>
                    <Avatar className="w-8 h-8 shrink-0">
                      <AvatarImage src={m.opponent_avatar ?? undefined} />
                      <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-xs font-bold">
                        {m.opponent.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{m.opponent}</p>
                      <p className="text-[#7ab5cc] text-xs">
                        {m.my_score} — {m.opp_score} · {new Date(m.played_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <ResultBadge result={m.result} />
                      {m.elo_delta !== 0 && (
                        <p className={cn("text-xs font-medium mt-0.5", m.elo_delta > 0 ? "text-[#06d6a0]" : "text-[#ef476f]")}>
                          {formatPoints(m.elo_delta)}
                        </p>
                      )}
                    </div>
                  </div>
                );
                return isOwnProfile ? (
                  <Link key={m.match_id} href={`/result/${m.match_id}`}>{inner}</Link>
                ) : (
                  <div key={m.match_id}>{inner}</div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[#111111] rounded-xl p-3 text-center">
      <div className={cn("font-bold text-lg", accent ? "text-[#06d6a0]" : "text-white")}>{value}</div>
      <div className="text-[#7ab5cc] text-xs">{label}</div>
    </div>
  );
}

function ResultBadge({ result }: { result: "win" | "loss" | "draw" }) {
  if (result === "win") return <span className="text-xs font-bold text-[#06d6a0]">W</span>;
  if (result === "loss") return <span className="text-xs font-bold text-[#ef476f]">L</span>;
  return <span className="text-xs font-bold text-[#7ab5cc]">D</span>;
}
