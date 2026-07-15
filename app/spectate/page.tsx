import { redirect } from "next/navigation";
import Link from "next/link";
import { Eye } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

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
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-center">
          <h1 className="text-white font-semibold">Spectate</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {matches.length === 0 ? (
          <div className="bg-[#111111] rounded-xl p-8 text-center">
            <p className="text-[#4a8fa8] text-sm">No live matches right now.</p>
          </div>
        ) : (
          <div className="space-y-0 bg-[#111111] rounded-xl overflow-hidden">
            {matches.map((m) => (
              <Link
                key={m.match_id}
                href={`/spectate/${m.match_id}`}
                className="flex items-center gap-3 px-4 py-3 border-b border-[#1a1a1a] last:border-0 hover:bg-[#1a1a1a] transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">
                    {m.player_a_username} <span className="text-[#4a8fa8]">vs</span> {m.player_b_username}
                  </p>
                  <p className="text-[#7ab5cc] text-xs">
                    Q{m.current_index + 1} of 9 · {m.score_a} — {m.score_b}
                  </p>
                </div>
                <Eye size={16} className="text-[#4a8fa8] shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
