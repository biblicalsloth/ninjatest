import { createPublicClient } from "@/lib/supabase/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LeaderboardTable, type LeaderboardEntry } from "./leaderboard-table";

// Fully public page. Cache + revalidate every 60s with a cookie-less anon
// client so it does NOT run a fresh ranked scan of `profiles` (+ an auth
// lookup) on every visitor/bot hit. The "(you)" highlight is resolved
// client-side in <LeaderboardTable/>.
export const revalidate = 60;

export default async function LeaderboardPage() {
  const supabase = createPublicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows } = await (supabase as any).rpc("get_leaderboard", { p_limit: 100, p_offset: 0 });

  const entries = ((rows ?? []) as unknown[]) as LeaderboardEntry[];

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <header className="border-b border-[#222222] px-4 py-3">
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
        <LeaderboardTable entries={entries} />

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
        <AvatarFallback className="bg-[#111111] text-[#06d6a0] font-bold">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="text-white text-xs font-medium truncate max-w-[80px] text-center">{name}</p>
      <p className="text-[#ffd166] font-bold text-sm">{entry.elo}</p>
      <div className={`w-full ${heights[pos as 1|2|3]} bg-[#111111] rounded-t-xl flex items-start justify-center pt-2`}>
        <span className="text-xl">{labels[pos - 1]}</span>
      </div>
    </div>
  );
}
