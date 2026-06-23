"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import { Sword, Shield, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface ChallengeInfo {
  code: string;
  host_username: string;
  host_avatar: string | null;
  host_elo: number;
  is_rated: boolean;
  expires_at: string;
}

export default function JoinChallengePage() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [info, setInfo] = useState<ChallengeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchInfo() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.push(`/auth/login?next=/c/${code}`);
        return;
      }

      /* Load challenge + host profile */
      const { data: challengeRaw } = await supabase
        .from("challenges")
        .select("code, host_id, is_rated, expires_at, guest_id")
        .eq("code", code)
        .single();

      const challenge = challengeRaw as {
        code: string; host_id: string; is_rated: boolean;
        expires_at: string; guest_id: string | null;
      } | null;

      if (!challenge) {
        setError("Challenge not found or has expired.");
        setLoading(false);
        return;
      }

      if (challenge.guest_id) {
        setError("This challenge has already been accepted.");
        setLoading(false);
        return;
      }

      if (new Date(challenge.expires_at) < new Date()) {
        setError("This challenge link has expired.");
        setLoading(false);
        return;
      }

      if (challenge.host_id === user.id) {
        setError("You cannot accept your own challenge.");
        setLoading(false);
        return;
      }

      const { data: hostProfileRaw } = await supabase
        .from("profiles")
        .select("username, avatar_url, elo")
        .eq("id", challenge.host_id)
        .single();

      const hostProfile = hostProfileRaw as {
        username: string; avatar_url: string | null; elo: number;
      } | null;

      setInfo({
        code: challenge.code,
        host_username: hostProfile?.username ?? "Unknown",
        host_avatar: hostProfile?.avatar_url ?? null,
        host_elo: hostProfile?.elo ?? 1000,
        is_rated: challenge.is_rated,
        expires_at: challenge.expires_at,
      });
      setLoading(false);
    }

    fetchInfo();
  }, [code, router]);

  async function handleAccept() {
    setAccepting(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: matchId, error: err } = await (supabase as any).rpc("accept_challenge", { p_code: code });
    if (err || !matchId) {
      toast.error(err?.message ?? "Failed to accept challenge");
      setAccepting(false);
      return;
    }
    router.push(`/match/${matchId}`);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#001e2b] flex items-center justify-center">
        <p className="text-[#5c6c7a]">Loading challenge…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#001e2b] flex items-center justify-center px-4">
        <div className="text-center space-y-4">
          <div className="text-4xl">😵</div>
          <h1 className="text-white text-xl font-bold">Challenge unavailable</h1>
          <p className="text-[#5c6c7a] text-sm max-w-xs">{error}</p>
          <Button
            onClick={() => router.push("/lobby")}
            className="bg-[#00ed64] text-[#001e2b] font-semibold rounded-full px-6"
          >
            Go to Lobby
          </Button>
        </div>
      </div>
    );
  }

  if (!info) return null;

  const expiresIn = Math.max(0, Math.floor((new Date(info.expires_at).getTime() - Date.now()) / 60000));

  return (
    <div className="min-h-screen bg-[#001e2b] flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="w-10 h-10 rounded-full bg-[#00ed64] flex items-center justify-center mx-auto mb-3">
            <span className="text-[#001e2b] font-bold text-sm">N</span>
          </div>
          <h1 className="text-white text-2xl font-bold">Battle Challenge</h1>
          <p className="text-[#5c6c7a] text-sm mt-1">You&apos;ve been challenged!</p>
        </div>

        {/* Challenger card */}
        <div className="bg-[#1c2d38] rounded-xl p-5 text-center space-y-3">
          <Avatar className="w-16 h-16 mx-auto">
            <AvatarImage src={info.host_avatar ?? undefined} />
            <AvatarFallback className="bg-[#003d4f] text-[#00ed64] text-xl font-bold">
              {info.host_username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-white font-bold text-lg">{info.host_username}</p>
            <p className="text-[#00ed64] font-semibold">{info.host_elo} ELO</p>
          </div>

          <div className="flex items-center justify-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              {info.is_rated ? (
                <>
                  <Sword size={14} className="text-[#00ed64]" />
                  <span className="text-[#00ed64] font-medium">Rated match</span>
                </>
              ) : (
                <>
                  <Shield size={14} className="text-[#a8b3bc]" />
                  <span className="text-[#a8b3bc]">Unrated / practice</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 text-[#5c6c7a]">
              <Clock size={12} />
              <span className="text-xs">{expiresIn}m left</span>
            </div>
          </div>

          <p className="text-[#5c6c7a] text-xs">
            9 questions · VARC + DILR + Quant · Synchronized timer
          </p>
        </div>

        {/* Match type disclaimer */}
        {info.is_rated && (
          <div className="bg-[#00ed64]/5 border border-[#00ed64]/20 rounded-lg px-4 py-3 text-xs text-[#a8b3bc]">
            This is a <span className="text-[#00ed64] font-semibold">rated match</span>. Your ELO will change based on the outcome.
          </div>
        )}

        {/* Accept */}
        <Button
          onClick={handleAccept}
          disabled={accepting}
          className="w-full h-14 bg-[#00ed64] text-[#001e2b] font-bold text-base rounded-full hover:bg-[#00b545] transition-colors"
        >
          {accepting ? "Starting match…" : "Accept Challenge"}
        </Button>

        <Button
          onClick={() => router.push("/lobby")}
          variant="ghost"
          className="w-full text-[#5c6c7a] hover:text-white"
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
