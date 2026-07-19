"use client";

export const dynamic = "force-dynamic";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Zap, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function QueuePage() {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [startingBot, setStartingBot] = useState(false);
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
      // The realtime event, the SUBSCRIBED fallback read, the heartbeat and the
      // poll below can all land at once — first one wins, the rest no-op.
      if (matchedRef.current) return true;
      // Clear the "Joining queue…" gate so the initiator (matched via the entry
      // read, before setVerifying(false) ran) also sees the "Opponent found!"
      // card, not the loading text — same handoff screen for both players.
      setVerifying(false);
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
          // A transient queue-row read can land here while a live match
          // already exists — join_queue then raises 'already in a live
          // match'. Route into that match instead of stranding the player
          // in the lobby while the opponent waits alone.
          const { data: liveRaw } = await supabase
            .from("matches")
            .select("id")
            .or(`player_a.eq.${user.id},player_b.eq.${user.id}`)
            .in("status", ["pending", "active"])
            .limit(1)
            .maybeSingle();
          const live = liveRaw as { id: string } | null;
          if (live && (await handleMatched(live.id, supabase))) return;
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
            } else if (row.status === "cancelled" && !matchedRef.current && !document.hidden) {
              // Server ghost-sweep cancelled us (stale heartbeat, e.g. laptop
              // sleep) while the page is still open — rejoin. Skip when the tab
              // is backgrounded: a tab nobody's watching should stay swept, not
              // re-poison the pool. Resumes when the heartbeat sees it visible.
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

      // Deterministic "matched" detection: realtime is the fast path, but a
      // silently dead socket (sleep, network flap) fires no event and no
      // CHANNEL_ERROR — the waiting player then only learns via the 20s
      // heartbeat. Poll our own queue row (cheap indexed own-row select) so the
      // worst case is ~4s, not 20s. Realtime still usually wins.
      pollId = setInterval(async () => {
        if (matchedRef.current || document.hidden) return;
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
      }, 4000);
    }

    let pollId: ReturnType<typeof setInterval> | null = null;
    setup();

    // Liveness heartbeat: the server cancels waiting rows whose heartbeat is
    // >90s stale, so an abandoned tab can't poison the matchmaking pool.
    // ponytail: 15-min hard cap; nobody queues that long, and it bounds the
    // ping+rejoin cost of a tab left open forever. Raise if real queues run long.
    const MAX_QUEUE_MS = 15 * 60_000;
    const heartbeat = setInterval(async () => {
      const sb = supabaseRef.current;
      if (!sb || matchedRef.current) return;
      if (Date.now() - startRef.current > MAX_QUEUE_MS) {
        clearInterval(heartbeat);
        sb.rpc("leave_queue").then(() => {}, () => {});
        toast.info("Search paused — still here?");
        router.push("/lobby");
        return;
      }
      // Backgrounded tab: skip the ping. Server sweeps us at 90s; we rejoin on
      // the next visible heartbeat. Keeps idle tabs off the DB and the pool.
      if (document.hidden) return;
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
      if (pollId) clearInterval(pollId);
      channelRef.current?.unsubscribe();
      // Leaving the page without cancelling used to strand a ghost waiting
      // row. leave_queue only touches 'waiting' rows, so this is a no-op when
      // we routed into a match. Fire-and-forget.
      supabaseRef.current?.rpc("leave_queue").then(() => {}, () => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handlePlayBot() {
    const sb = supabaseRef.current;
    if (!sb || matchedRef.current) return;
    setStartingBot(true);
    const { data, error } = await sb.rpc("match_with_bot");
    if (error || !data) {
      toast.error("Bot unavailable right now — keep searching");
      setStartingBot(false);
      return;
    }
    matchedRef.current = true;
    router.push(`/match/${data}`);
  }

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

      {/* Bot fallback — server refuses before 15s of genuine waiting; show at
          20s so client elapsed (page mount) can't outrun server enqueued_at */}
      {elapsed >= 20 && (
        <Button
          onClick={handlePlayBot}
          disabled={startingBot || cancelling}
          className="mb-3 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full px-6 hover:bg-[#05b088] flex items-center gap-2"
        >
          <Bot size={14} />
          {startingBot ? "Starting…" : "Play Ninja Bot · unrated"}
        </Button>
      )}

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
