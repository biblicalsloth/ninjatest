"use client";

export const dynamic = "force-dynamic";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function QueuePage() {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const startRef = useRef(Date.now());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);

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

    async function setup() {
      const { createClient } = await import("@/lib/supabase/client");
      supabase = createClient();

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
        router.push(`/match/${queueRow.match_id}`);
        return;
      }

      if (!queueRow || queueRow.status !== "waiting") {
        // Not in queue — join now
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
          (payload: { new: { status: string; match_id: string | null } }) => {
            const row = payload.new;
            if (row.status === "matched" && row.match_id) {
              router.push(`/match/${row.match_id}`);
            }
          }
        )
        .subscribe();

      channelRef.current = channel;
    }

    setup();

    return () => {
      channelRef.current?.unsubscribe();
    };
  }, [router]);

  async function handleCancel() {
    setCancelling(true);
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const { error } = await supabase.rpc("leave_queue");
    if (error) {
      toast.error("Failed to leave queue");
      setCancelling(false);
      return;
    }
    router.push("/lobby");
  }

  // Band grows 20 ELO/sec from base 100, capped at 1000.
  // Server uses GREATEST(my_band, opp_band), so actual match range may be wider.
  const currentBand = Math.min(1000, 100 + elapsed * 20);

  if (verifying) {
    return (
      <div className="min-h-screen bg-[#001e2b] flex items-center justify-center">
        <p className="text-[#5c6c7a] text-sm">Joining queue…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#001e2b] flex flex-col items-center justify-center px-4">
      {/* Animated search indicator */}
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full border-2 border-[#00ed64]/20 animate-ping" style={{ transform: "scale(1.5)" }} />
        <div className="absolute inset-0 rounded-full border-2 border-[#00ed64]/10 animate-ping" style={{ transform: "scale(2)", animationDelay: "0.5s" }} />
        <div className="w-24 h-24 rounded-full bg-[#1c2d38] border-2 border-[#00ed64]/30 flex items-center justify-center">
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-2 h-2 rounded-full bg-[#00ed64] inline-block"
                style={{
                  animation: `queueBounce 1.4s ease-in-out ${i * 0.16}s infinite`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <h1 className="text-white text-2xl font-bold mb-1">Finding your opponent…</h1>
      <p className="text-[#5c6c7a] text-sm mb-8">
        Your band: ±{currentBand} ELO{currentBand >= 1000 ? " (any)" : ""} · {formatTime(elapsed)} elapsed
      </p>

      <div className="flex gap-6 mb-10 text-center">
        <div>
          <div className="text-[#00ed64] font-bold text-lg">{currentBand}</div>
          <div className="text-[#5c6c7a] text-xs">ELO band</div>
        </div>
        <div className="w-px bg-[#1c2d38]" />
        <div>
          <div className="text-white font-bold text-lg">{formatTime(elapsed)}</div>
          <div className="text-[#5c6c7a] text-xs">Searching</div>
        </div>
        <div className="w-px bg-[#1c2d38]" />
        <div>
          <div className="text-[#a8b3bc] font-bold text-lg">9 Qs</div>
          <div className="text-[#5c6c7a] text-xs">Match length</div>
        </div>
      </div>

      <Button
        onClick={handleCancel}
        disabled={cancelling}
        variant="outline"
        className="border-[#3d4f5b] text-[#a8b3bc] rounded-full px-6 hover:bg-[#1c2d38] flex items-center gap-2"
      >
        <X size={14} />
        {cancelling ? "Cancelling…" : "Cancel search"}
      </Button>

      <style>{`
        @keyframes queueBounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
