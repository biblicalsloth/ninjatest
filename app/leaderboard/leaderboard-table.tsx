"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";
import { getWinRate } from "@/lib/utils";

export interface LeaderboardEntry {
  rank: number;
  username: string;
  display_name: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  avatar_url: string | null;
}

/**
 * Renders the leaderboard rows. The "(you)" highlight is resolved client-side
 * (one auth lookup on mount) so the parent page stays statically/ISR cached
 * instead of rendering per request.
 */
export function LeaderboardTable({ entries }: { entries: LeaderboardEntry[] }) {
  const [myUsername, setMyUsername] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: p } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", data.user.id)
        .single();
      if (p) setMyUsername((p as { username: string }).username);
    });
  }, []);

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const isMe = myUsername === entry.username;
        const winRate = getWinRate(entry.wins, entry.wins + entry.losses + entry.draws);
        return (
          <Link key={entry.username} href={`/profile/${entry.username}`}>
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors hover:bg-[#111111] ${
              isMe ? "bg-[#06d6a0]/5 border border-[#06d6a0]/20" : ""
            }`}>
              {/* Rank */}
              <div className="w-8 text-center shrink-0">
                {entry.rank <= 3 ? (
                  <span className="text-lg">{["🥇","🥈","🥉"][entry.rank - 1]}</span>
                ) : (
                  <span className="text-[#4a8fa8] text-sm font-mono">#{entry.rank}</span>
                )}
              </div>

              {/* Avatar */}
              <Avatar className="w-8 h-8 shrink-0">
                <AvatarImage src={entry.avatar_url ?? undefined} />
                <AvatarFallback className="bg-[#111111] text-[#06d6a0] text-xs font-bold">
                  {entry.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">
                  {entry.display_name ?? entry.username}
                  {isMe && (
                    <span className="ml-2 text-[#06d6a0] text-xs">(you)</span>
                  )}
                </p>
                <p className="text-[#7ab5cc] text-xs">{winRate} win rate</p>
              </div>

              {/* ELO */}
              <div className="text-right shrink-0">
                <p className="text-[#ffd166] font-bold">{entry.elo}</p>
                <p className="text-[#4a8fa8] text-xs">{entry.wins}W {entry.losses}L</p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
