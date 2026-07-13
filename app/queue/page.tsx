"use client";

export const dynamic = "force-dynamic";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function QueuePage() {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [matchFound, setMatchFound] = useState<{ matchId: string; opponent: string | null } | null>(null);
  const startRef = useRef(Date.now());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseRef = useRef<any>(null);
  const matchedRef = useRef(false);

  /* Timer */
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* Verify in queue + listen for match */
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let supabase: ReturnType<typeof import("@/lib/supabase/client").createClient>;

    async function handleMatched(matchId: string, sb: typeof supabase): Promise<boolean> {
      // Fetch the match; a stale 'matched' queue row can point at a long-dead
      // match — only route into live ones.
      const { data: matchRaw } = await sb.from("matches").select("player_a, player_b, status").eq("id", matchId).single();
      const m = matchRaw as { player_a: string; player_b: string; status: string } | null;
      if (!m || (m.status !== "pending" && m.status !== "active")) return false;
      const { data: { user } } = await sb.auth.getUser();
      let opponent: string | null = null;
      if (user) {
        const oppId = m.player_a === user.id ? m.player_b : m.player_a;
        const { data: profile } = await sb.from("profiles").select("display_name, username").eq("id", oppId).single();
        if (profile) {
          const p = profile as { display_name: string | null; username: string };
          opponent = p.display_name ?? p.username;
        }
      }
      matchedRef.current = true;
      setMatchFound({ matchId, opponent });
      setTimeout(() => router.push(`/match/${matchId}`), 1500);
      return true;
    }

    async function setup() {
      const { createClient } = await import("@/lib/supabase/client");
      supabase = createClient();
      supabaseRef.current = supabase;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/auth/login"); return; }

      // Verify user actually has a waiting queue row; if not, join now
      const { data: queueRowRaw } = await supabase
        .from("matchmaking_queue")
        .select("status, match_id")
        .eq("user_id", user.id)
        .order("enqueued_at", { ascending: false })
        .limit(1)
        .single();
      const queueRow = queueRowRaw as { status: string; match_id: string | null } | null;

      if (queueRow?.status === "matched" && queueRow.match_id) {
        if (await handleMatched(queueRow.match_id, supabase)) return;
        // stale matched row — fall through and queue fresh
      }

      if (!queueRow || queueRow.status !== "waiting") {
        const { error } = await supabase.rpc("join_queue");
        if (error) {
          toast.error("Failed to join queue");
          router.push("/lobby");
          return;
        }
      }

      setVerifying(false);

      const channel = supabase
        .channel(`queue:${user.id}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "matchmaking_queue",
            filter: `user_id=eq.${user.id}`,
          },
          async (payload: { new: { status: string; match_id: string | null } }) => {
            const row = payload.new;
            if (row.status === "matched" && row.match_id) {
              await handleMatched(row.match_id, supabase);
            } else if (row.status === "cancelled" && !matchedRef.current) {
              // Server ghost-sweep cancelled us (stale heartbeat, e.g. laptop
              // sleep) while the page is still open — rejoin.
              const { error } = await supabase.rpc("join_queue");
              if (error) { toast.error("Removed from queue"); router.push("/lobby"); }
            }
          }
        )
        .subscribe(async (status) => {
          // A dropped/errored socket can miss the "matched" event, stranding the
          // player in the queue while the opponent sits in a live match alone.
          // On (re)subscribe or error, re-read the queue row as a fallback.
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            const { data } = await supabase
              .from("matchmaking_queue")
              .select("status, match_id")
              .eq("user_id", user.id)
              .order("enqueued_at", { ascending: false })
              .limit(1)
              .single();
            const row = data as { status: string; match_id: string | null } | null;
            if (row?.status === "matched" && row.match_id) {
              await handleMatched(row.match_id, supabase);
            }
          }
        });

      channelRef.current = channel;
    }

    setup();

    // Liveness heartbeat: the server cancels waiting rows whose heartbeat is
    // >90s stale, so an abandoned tab can't poison the matchmaking pool.
    const heartbeat = setInterval(async () => {
      const sb = supabaseRef.current;
      if (!sb || matchedRef.current) return;
      const { data, error } = await sb.rpc("queue_heartbeat");
      if (error || data !== false) return;
      // No waiting row anymore: either we got matched or we were swept.
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: rowRaw } = await sb
        .from("matchmaking_queue")
        .select("status, match_id")
        .eq("user_id", user.id)
        .order("enqueued_at", { ascending: false })
        .limit(1)
        .single();
      const row = rowRaw as { status: string; match_id: string | null } | null;
      if (row?.status === "matched" && row.match_id) {
        await handleMatched(row.match_id, sb);
      } else if (!matchedRef.current) {
        await sb.rpc("join_queue").then(() => {}, () => {});
      }
    }, 20_000);

    return () => {
      clearInterval(heartbeat);
      channelRef.current?.unsubscribe();
      // Leaving the page without cancelling used to strand a ghost waiting
      // row. leave_queue only touches 'waiting' rows, so this is a no-op when
      // we routed into a match. Fire-and-forget.
      supabaseRef.current?.rpc("leave_queue").then(() => {}, () => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handleCancel() {
    setCancelling(true);
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const { data, error } = await supabase.rpc("leave_queue");
    if (error) {
      toast.error("Failed to leave queue");
      setCancelling(false);
      return;
    }
    if (data === false) {
      // Lost the leave-vs-match race: our row was already consumed by the
      // matcher. Route into the match instead of stranding the opponent.
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: rowRaw } = await supabase
          .from("matchmaking_queue")
          .select("status, match_id")
          .eq("user_id", user.id)
          .order("enqueued_at", { ascending: false })
          .limit(1)
          .single();
        const row = rowRaw as { status: string; match_id: string | null } | null;
        if (row?.status === "matched" && row.match_id) {
          matchedRef.current = true;
          router.push(`/match/${row.match_id}`);
          return;
        }
      }
    }
    router.push("/lobby");
  }

  const currentBand = Math.min(1000, 100 + elapsed * 20);

  if (verifying) {
    return (
      <div className="min-h-screen bg-[#120F17] flex items-center justify-center">
        <p className="text-[#7ab5cc] text-sm">Joining queue…</p>
      </div>
    );
  }

  if (matchFound) {
    return (
      <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4">
        <div className="w-20 h-20 rounded-full bg-[#06d6a0]/10 border-2 border-[#06d6a0] flex items-center justify-center mb-6 animate-pulse">
          <Zap size={32} className="text-[#06d6a0]" />
        </div>
        <h1 className="text-white text-2xl font-bold mb-2">Opponent found!</h1>
        {matchFound.opponent && (
          <p className="text-[#7ab5cc] text-sm mb-1">vs <span className="text-white font-semibold">{matchFound.opponent}</span></p>
        )}
        <p className="text-[#4a8fa8] text-xs">Loading match…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#120F17] flex flex-col items-center justify-center px-4">
      {/* Animated search indicator */}
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full border-2 border-[#06d6a0]/20 motion-safe:animate-ping" style={{ transform: "scale(1.5)" }} />
        <div className="absolute inset-0 rounded-full border-2 border-[#06d6a0]/10 motion-safe:animate-ping" style={{ transform: "scale(2)", animationDelay: "0.5s" }} />
        <div className="w-24 h-24 rounded-full bg-[#0a4f66] border-2 border-[#06d6a0]/40 flex items-center justify-center">
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="queue-dot w-2 h-2 rounded-full bg-[#06d6a0] inline-block"
                style={{
                  animation: `queueBounce 1.4s ease-in-out ${i * 0.16}s infinite`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <h1 className="text-white text-2xl font-bold mb-1">Finding your opponent…</h1>
      <p className="text-[#7ab5cc] text-sm mb-8">
        Your band: ±{currentBand} ELO{currentBand >= 1000 ? " (any)" : ""} · {formatTime(elapsed)} elapsed
      </p>

      <div className="flex gap-6 mb-10 text-center">
        <div>
          <div className="text-[#ffd166] font-bold text-lg">{currentBand}</div>
          <div className="text-[#7ab5cc] text-xs">ELO band</div>
        </div>
        <div className="w-px bg-[#222222]" />
        <div>
          <div className="text-white font-bold text-lg">{formatTime(elapsed)}</div>
          <div className="text-[#7ab5cc] text-xs">Searching</div>
        </div>
        <div className="w-px bg-[#222222]" />
        <div>
          <div className="text-[#c5e8f0] font-bold text-lg">9 Qs</div>
          <div className="text-[#7ab5cc] text-xs">Match length</div>
        </div>
      </div>

      <Button
        onClick={handleCancel}
        disabled={cancelling}
        variant="outline"
        className="border-[#2a7a9a] text-[#c5e8f0] rounded-full px-6 hover:bg-[#0a4f66] flex items-center gap-2"
      >
        <X size={14} />
        {cancelling ? "Cancelling…" : "Cancel search"}
      </Button>
    </div>
  );
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
