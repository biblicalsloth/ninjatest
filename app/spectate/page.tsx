import { redirect } from "next/navigation";
import Link from "next/link";
import { Eye } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Enter } from "@/components/enter";

interface ActiveMatch {
  match_id: string;
  player_a_username: string;
  player_a_elo: number;
  player_b_username: string;
  player_b_elo: number;
  score_a: number;
  score_b: number;
  current_index: number;
  started_at: string;
}

export default async function SpectatePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc("get_active_matches", { p_limit: 20 });
  const matches = (data ?? []) as ActiveMatch[];

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      {/* Header sits in the app-wide max-w-5xl box so the logo lands in the same
          spot as the lobby; the narrower content column below keeps max-w-2xl. */}
      <div className="max-w-5xl mx-auto px-4 pt-6">
        <PageHeader
          label="Spectate"
          sub={
            matches.length === 0
              ? "Watch live battles as they happen"
              : `${matches.length} live ${matches.length === 1 ? "match" : "matches"} right now`
          }
        />
      </div>
      <main className="max-w-2xl mx-auto px-4 pb-24">

        {matches.length === 0 ? (
          <Enter>
          <div className="mt-6 bg-[#111111] border border-[#1c1a24] rounded-xl px-6 py-16 text-center">
            <Eye size={28} className="mx-auto mb-3 text-[#4a8fa8]" />
            <p className="text-white text-sm font-medium">No live matches right now</p>
            <p className="text-[#4a8fa8] text-xs mt-1">
              Matches show up here the moment two players start battling. Check back in a bit.
            </p>
          </div>
          </Enter>
        ) : (
          <Enter className="mt-6 space-y-2">
            {matches.map((m) => (
              <Link
                key={m.match_id}
                href={`/spectate/${m.match_id}`}
                className="group flex items-center gap-3 px-4 py-3.5 rounded-xl bg-[#111111] border border-[#1c1a24] hover:border-[#06d6a0]/40 transition-colors"
              >
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[#06d6a0] opacity-60 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#06d6a0]" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">
                    {m.player_a_username}
                    <span className="text-[#4a8fa8] font-mono text-xs mx-1">{m.player_a_elo}</span>
                    <span className="text-[#4a8fa8]">vs</span>
                    <span className="ml-1">{m.player_b_username}</span>
                    <span className="text-[#4a8fa8] font-mono text-xs ml-1">{m.player_b_elo}</span>
                  </p>
                  <p className="text-[#7ab5cc] text-xs mt-0.5">
                    Q{m.current_index + 1} of 9 ·{" "}
                    <span className="text-[#ffd166] font-semibold">{m.score_a} — {m.score_b}</span>
                  </p>
                </div>
                <Eye size={16} className="text-[#4a8fa8] group-hover:text-[#06d6a0] shrink-0 transition-colors" />
              </Link>
            ))}
          </Enter>
        )}
      </main>
    </div>
  );
}
