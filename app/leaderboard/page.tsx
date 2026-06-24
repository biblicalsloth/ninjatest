import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getWinRate } from "@/lib/utils";

export const revalidate = 60;

export default async function LeaderboardPage() {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows } = await (supabase as any).rpc("get_leaderboard", { p_limit: 100, p_offset: 0 });
  const { data: { user } } = await supabase.auth.getUser();

  const myProfileResult = user
    ? await supabase.from("profiles").select("username").eq("id", user.id).single()
    : { data: null };
  const myProfile = myProfileResult.data as { username: string } | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = ((rows ?? []) as any[]) as {
    rank: number;
    username: string;
    display_name: string | null;
    elo: number;
    wins: number;
    losses: number;
    avatar_url: string | null;
  }[];

  return (
    <div className="min-h-screen bg-[#073b4c] text-white">
      <header className="border-b border-[#1a6080] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/lobby" className="text-[#7ab5cc] hover:text-white transition-colors flex items-center gap-1.5 text-sm">
            <ArrowLeft size={14} />
            Back
          </Link>
          <h1 className="text-white font-semibold">Leaderboard</h1>
          <div className="w-12" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {/* Top 3 podium */}
        {entries.length >= 3 && (
          <div className="flex items-end justify-center gap-3 mb-8">
            <PodiumCard entry={entries[1]} pos={2} />
            <PodiumCard entry={entries[0]} pos={1} />
            <PodiumCard entry={entries[2]} pos={3} />
          </div>
        )}

        {/* Table */}
        <div className="space-y-1">
          {entries.map((entry) => {
            const isMe = myProfile?.username === entry.username;
            const winRate = getWinRate(entry.wins, entry.wins + entry.losses);
            return (
              <Link key={entry.username} href={`/profile/${entry.username}`}>
                <div className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors hover:bg-[#0a4f66] ${
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
                    <AvatarFallback className="bg-[#0a4f66] text-[#06d6a0] text-xs font-bold">
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

        {entries.length === 0 && (
          <div className="text-center py-16">
            <p className="text-[#4a8fa8]">No players yet. Be the first!</p>
          </div>
        )}
      </main>
    </div>
  );
}

function PodiumCard({ entry, pos }: { entry: { username: string; display_name: string | null; elo: number; avatar_url: string | null }; pos: number }) {
  const heights = { 1: "h-28", 2: "h-20", 3: "h-16" };
  const labels = ["🥇", "🥈", "🥉"];
  const name = entry.display_name ?? entry.username;

  return (
    <div className="flex flex-col items-center gap-2 flex-1">
      <Avatar className={`${pos === 1 ? "w-14 h-14" : "w-10 h-10"}`}>
        <AvatarImage src={entry.avatar_url ?? undefined} />
        <AvatarFallback className="bg-[#0a4f66] text-[#06d6a0] font-bold">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="text-white text-xs font-medium truncate max-w-[80px] text-center">{name}</p>
      <p className="text-[#ffd166] font-bold text-sm">{entry.elo}</p>
      <div className={`w-full ${heights[pos as 1|2|3]} bg-[#0a4f66] rounded-t-xl flex items-start justify-center pt-2`}>
        <span className="text-xl">{labels[pos - 1]}</span>
      </div>
    </div>
  );
}
