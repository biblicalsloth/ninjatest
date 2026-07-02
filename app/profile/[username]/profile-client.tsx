"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Settings, Swords, Trophy, BarChart2, History, Flame } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EloGraph } from "@/components/elo-graph";
import { cn, getWinRate, formatPoints } from "@/lib/utils";
import { getLeague } from "@/lib/leagues";
import { createClient } from "@/lib/supabase/client";

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

interface SectionStat {
  section: "VARC" | "DILR" | "QUANT";
  questions_answered: number;
  correct: number;
  accuracy: number;
  avg_points: number;
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profileData: any;
  recentMatches: unknown[];
  sectionStats: unknown[];
}

type Tab = "overview" | "history" | "stats";

const SECTION_LABELS: Record<string, string> = { VARC: "Verbal", DILR: "Logical", QUANT: "Quant" };
const SECTION_COLORS: Record<string, string> = {
  VARC:  "text-[#7ab5cc] border-[#7ab5cc]/30  bg-[#7ab5cc]/10",
  DILR:  "text-[#ffd166] border-[#ffd166]/30  bg-[#ffd166]/10",
  QUANT: "text-[#06d6a0] border-[#06d6a0]/30  bg-[#06d6a0]/10",
};
const SECTION_BAR: Record<string, string> = {
  VARC:  "bg-[#7ab5cc]",
  DILR:  "bg-[#ffd166]",
  QUANT: "bg-[#06d6a0]",
};

export default function ProfileClient({ profileData, recentMatches, sectionStats }: Props) {
  const { profile, curve, rank } = profileData;
  const league = getLeague(profile.elo);
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [challenging, setChallenging] = useState(false);

  // Computed client-side so the page itself can be statically/ISR cached
  // (reading the auth cookie on the server would force per-request rendering).
  const [isOwnProfile, setIsOwnProfile] = useState(false);
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setIsOwnProfile(!!data.user && data.user.id === profile?.id);
    });
  }, [profile?.id]);

  const winRate = getWinRate(profile.wins, profile.matches_played);
  const matches = recentMatches as RecentMatch[];
  const stats = sectionStats as SectionStat[];

  async function handleChallenge() {
    setChallenging(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/auth/login"); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: code, error } = await (supabase as any).rpc("create_challenge", { p_is_rated: true });
    if (error || !code) {
      toast.error("Failed to create challenge");
      setChallenging(false);
      return;
    }
    const link = `${window.location.origin}/c/${code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Challenge link copied! Share it with " + (profile.display_name ?? profile.username));
    } catch {
      toast.success("Challenge created! Link: " + link);
    }
    setChallenging(false);
  }

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
              <Badge className="bg-[#06d6a0]/10 text-[#06d6a0] border border-[#06d6a0]/30 text-xs px-2 py-0.5">
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

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">

        {/* ── Hero card ── */}
        <div className="bg-[#111111] rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <Avatar className="w-20 h-20 shrink-0">
              <AvatarImage src={profile.avatar_url ?? undefined} />
              <AvatarFallback className="bg-[#0a4f66] text-[#06d6a0] text-2xl font-bold">
                {profile.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-white text-xl font-bold truncate leading-tight">
                  {profile.display_name ?? profile.username}
                </h1>
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
              <p className="text-[#7ab5cc] text-sm mb-3">@{profile.username}</p>

              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <span className="text-[#ffd166] font-bold text-2xl">{profile.elo}</span>
                  <span className="text-[#7ab5cc] text-xs ml-1">ELO</span>
                </div>
                <div className="w-px h-5 bg-[#2a2a2a]" />
                <div>
                  <span className="text-white font-semibold">{profile.peak_elo}</span>
                  <span className="text-[#7ab5cc] text-xs ml-1">Peak</span>
                </div>
                {rank && (
                  <>
                    <div className="w-px h-5 bg-[#2a2a2a]" />
                    <div className="flex items-center gap-1">
                      <Trophy size={13} className="text-[#ffd166]" />
                      <span className="text-[#ffd166] font-semibold">#{rank}</span>
                      <span className="text-[#7ab5cc] text-xs">ranked</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-5 gap-2 mt-4 pt-4 border-t border-[#1a1a1a]">
            <MiniStat label="Played" value={profile.matches_played.toString()} />
            <MiniStat label="Win rate" value={winRate} accent />
            <MiniStat label="W / L" value={`${profile.wins}/${profile.losses}`} />
            <MiniStat label="Draws" value={profile.draws.toString()} />
            <MiniStat
              label="Streak"
              value={profile.current_streak > 0 ? `${profile.current_streak}` : "0"}
              icon={profile.current_streak > 0 ? <Flame size={12} className="text-[#ffd166]" /> : undefined}
            />
          </div>

          {/* Challenge button for other users */}
          {!isOwnProfile && (
            <Button
              onClick={handleChallenge}
              disabled={challenging}
              className="w-full mt-4 h-10 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] flex items-center gap-2"
            >
              <Swords size={15} />
              {challenging ? "Creating challenge…" : `Challenge ${profile.display_name ?? profile.username}`}
            </Button>
          )}
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-1 bg-[#111111] rounded-xl p-1">
          {(["overview", "history", "stats"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 py-2 text-sm font-medium rounded-lg transition-colors capitalize",
                tab === t
                  ? "bg-[#1a1a1a] text-white"
                  : "text-[#7ab5cc] hover:text-white"
              )}
            >
              {t === "overview" && <span className="flex items-center justify-center gap-1.5"><Trophy size={13} />Overview</span>}
              {t === "history"  && <span className="flex items-center justify-center gap-1.5"><History size={13} />Matches</span>}
              {t === "stats"    && <span className="flex items-center justify-center gap-1.5"><BarChart2 size={13} />Sections</span>}
            </button>
          ))}
        </div>

        {/* ── Overview tab ── */}
        {tab === "overview" && (
          <div className="space-y-4">
            {/* ELO graph */}
            {curve.length > 1 ? (
              <div className="bg-[#111111] rounded-xl p-5">
                <h2 className="text-[#7ab5cc] text-sm font-medium mb-4">Rating history</h2>
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
                <div className="space-y-0">
                  {[...curve].reverse().slice(0, 8).map((c: { elo: number; at: string; delta: number }, i: number) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0">
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
          </div>
        )}

        {/* ── Matches tab ── */}
        {tab === "history" && (
          <div className="bg-[#111111] rounded-xl p-5">
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-3">Match history</h2>
            {matches.length === 0 ? (
              <p className="text-[#4a8fa8] text-sm text-center py-6">No completed matches yet.</p>
            ) : (
              <div className="space-y-0">
                {matches.map((m) => {
                  const row = (
                    <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a] last:border-0">
                      <Avatar className="w-8 h-8 shrink-0">
                        <AvatarImage src={m.opponent_avatar ?? undefined} />
                        <AvatarFallback className="bg-[#0a4f66] text-[#06d6a0] text-xs font-bold">
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
                    <Link key={m.match_id} href={`/result/${m.match_id}`} className="block hover:opacity-80 transition-opacity">
                      {row}
                    </Link>
                  ) : (
                    <div key={m.match_id}>{row}</div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Section stats tab ── */}
        {tab === "stats" && (
          <div className="space-y-3">
            {stats.length === 0 ? (
              <div className="bg-[#111111] rounded-xl p-8 text-center">
                <p className="text-[#4a8fa8] text-sm">No section data yet. Complete matches to see stats.</p>
              </div>
            ) : (
              stats.map((s) => (
                <div key={s.section} className="bg-[#111111] rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <span className={cn("text-xs font-bold px-2.5 py-1 rounded-full border", SECTION_COLORS[s.section])}>
                      {SECTION_LABELS[s.section] ?? s.section}
                    </span>
                    <span className="text-[#4a8fa8] text-xs">{s.questions_answered} Qs answered</span>
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="text-center">
                      <div className="text-white font-bold text-xl">{s.accuracy}%</div>
                      <div className="text-[#7ab5cc] text-xs">Accuracy</div>
                    </div>
                    <div className="text-center">
                      <div className="text-white font-bold text-xl">{s.correct}</div>
                      <div className="text-[#7ab5cc] text-xs">Correct</div>
                    </div>
                    <div className="text-center">
                      <div className="text-white font-bold text-xl">{s.avg_points > 0 ? "+" : ""}{s.avg_points}</div>
                      <div className="text-[#7ab5cc] text-xs">Avg pts/Q</div>
                    </div>
                  </div>

                  {/* Accuracy bar */}
                  <div className="h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", SECTION_BAR[s.section])}
                      style={{ width: `${Math.max(2, s.accuracy)}%` }}
                    />
                  </div>
                </div>
              ))
            )}

            {/* Overall across all sections */}
            {stats.length > 0 && (
              <div className="bg-[#111111] rounded-xl p-5">
                <h3 className="text-[#7ab5cc] text-sm font-medium mb-3">Overall</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center">
                    <div className="text-white font-bold text-xl">
                      {stats.reduce((s, r) => s + r.questions_answered, 0)}
                    </div>
                    <div className="text-[#7ab5cc] text-xs">Total Qs</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[#06d6a0] font-bold text-xl">
                      {stats.reduce((s, r) => s + r.questions_answered, 0) > 0
                        ? Math.round(
                            (stats.reduce((s, r) => s + r.correct, 0) /
                              stats.reduce((s, r) => s + r.questions_answered, 0)) * 100
                          )
                        : 0}%
                    </div>
                    <div className="text-[#7ab5cc] text-xs">Accuracy</div>
                  </div>
                  <div className="text-center">
                    <div className="text-white font-bold text-xl">
                      {stats.reduce((s, r) => s + r.correct, 0)}
                    </div>
                    <div className="text-[#7ab5cc] text-xs">Correct</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string;
  accent?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="text-center">
      <div className={cn("font-bold text-base flex items-center justify-center gap-1", accent ? "text-[#06d6a0]" : "text-white")}>
        {icon}
        {value}
      </div>
      <div className="text-[#7ab5cc] text-xs">{label}</div>
    </div>
  );
}

function ResultBadge({ result }: { result: "win" | "loss" | "draw" }) {
  if (result === "win")  return <span className="text-xs font-bold text-[#06d6a0]">W</span>;
  if (result === "loss") return <span className="text-xs font-bold text-[#ef476f]">L</span>;
  return <span className="text-xs font-bold text-[#7ab5cc]">D</span>;
}
