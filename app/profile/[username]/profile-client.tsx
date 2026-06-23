"use client";

import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EloGraph } from "@/components/elo-graph";
import { getWinRate, formatPoints } from "@/lib/utils";

interface ProfileData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any;
  curve: { elo: number; at: string; delta: number }[];
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profileData: any;
  isOwnProfile: boolean;
}

export default function ProfileClient({ profileData, isOwnProfile }: Props) {
  const { profile, curve } = profileData;
  const winRate = getWinRate(profile.wins, profile.matches_played);

  return (
    <div className="min-h-screen bg-[#001e2b] text-white">
      {/* Nav */}
      <header className="border-b border-[#1c2d38] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/lobby" className="text-[#5c6c7a] hover:text-white transition-colors flex items-center gap-1.5 text-sm">
            <ArrowLeft size={14} />
            Back
          </Link>
          {isOwnProfile && (
            <Badge className="bg-[#00ed64]/10 text-[#00ed64] border-[#00ed64]/30 text-xs">
              Your profile
            </Badge>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Profile header */}
        <div className="flex items-center gap-4">
          <Avatar className="w-20 h-20">
            <AvatarImage src={profile.avatar_url ?? undefined} />
            <AvatarFallback className="bg-[#003d4f] text-[#00ed64] text-2xl font-bold">
              {profile.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h1 className="text-white text-xl font-bold truncate">
              {profile.display_name ?? profile.username}
            </h1>
            <p className="text-[#5c6c7a] text-sm">@{profile.username}</p>
            <div className="flex items-center gap-3 mt-2">
              <div>
                <span className="text-[#00ed64] font-bold text-xl">{profile.elo}</span>
                <span className="text-[#5c6c7a] text-xs ml-1">ELO</span>
              </div>
              <div className="w-px h-4 bg-[#1c2d38]" />
              <div>
                <span className="text-white font-semibold">{profile.peak_elo}</span>
                <span className="text-[#5c6c7a] text-xs ml-1">Peak</span>
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
          <div className="bg-[#1c2d38] rounded-xl p-5">
            <h2 className="text-[#a8b3bc] text-sm font-medium mb-4 flex items-center gap-1.5">
              <Trophy size={14} />
              Rating history
            </h2>
            <EloGraph data={curve} />
          </div>
        ) : (
          <div className="bg-[#1c2d38] rounded-xl p-8 text-center">
            <p className="text-[#5c6c7a] text-sm">
              Play rated matches to see your ELO history graph here.
            </p>
          </div>
        )}

        {/* Recent rating changes */}
        {curve.length > 0 && (
          <div className="bg-[#1c2d38] rounded-xl p-5">
            <h2 className="text-[#a8b3bc] text-sm font-medium mb-3">Recent rating changes</h2>
            <div className="space-y-2">
              {[...curve].reverse().slice(0, 8).map((c, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-[#1c2d38] last:border-0">
                  <div>
                    <span className="text-white text-sm font-medium">{c.elo}</span>
                    <span className="text-[#5c6c7a] text-xs ml-2">
                      {new Date(c.at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className={`text-sm font-semibold ${c.delta >= 0 ? "text-[#00ed64]" : "text-red-400"}`}>
                    {formatPoints(c.delta)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[#1c2d38] rounded-xl p-3 text-center">
      <div className={`font-bold text-lg ${accent ? "text-[#00ed64]" : "text-white"}`}>{value}</div>
      <div className="text-[#5c6c7a] text-xs">{label}</div>
    </div>
  );
}
