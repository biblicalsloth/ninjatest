"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, Clock } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function ChallengeDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [isRated, setIsRated] = useState(true);
  const [code, setCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  async function handleCreate() {
    setCreating(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("create_challenge", { p_is_rated: isRated });
    if (error || !data) {
      toast.error("Failed to create challenge");
      setCreating(false);
      return;
    }
    setCode(data as string);
    setCreating(false);

    const EXPIRY_SECS = 15 * 60;
    setSecondsLeft(EXPIRY_SECS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  function handleCopy() {
    if (!code) return;
    const url = `${window.location.origin}/c/${code}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Link copied!");
  }

  function handleClose() {
    setCode(null);
    setIsRated(true);
    setSecondsLeft(0);
    if (timerRef.current) clearInterval(timerRef.current);
    onOpenChange(false);
  }

  function fmtTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-[#1c2d38] border-[#3d4f5b] text-white max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-white">Challenge a Friend</DialogTitle>
          <DialogDescription className="text-[#5c6c7a]">
            Share a link for a 1v1 match. Link expires in 15 minutes.
          </DialogDescription>
        </DialogHeader>

        {!code ? (
          <div className="space-y-5 pt-2">
            {/* Rated toggle */}
            <div>
              <Label className="text-[#a8b3bc] text-sm mb-3 block">Match type</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setIsRated(true)}
                  className={`rounded-lg px-4 py-3 text-sm font-medium border transition-colors ${
                    isRated
                      ? "bg-[#00ed64]/10 border-[#00ed64]/50 text-[#00ed64]"
                      : "bg-[#001e2b] border-[#3d4f5b] text-[#5c6c7a] hover:border-[#5c6c7a]"
                  }`}
                >
                  <div className="font-semibold">Rated</div>
                  <div className="text-xs opacity-70 mt-0.5">ELO changes</div>
                </button>
                <button
                  onClick={() => setIsRated(false)}
                  className={`rounded-lg px-4 py-3 text-sm font-medium border transition-colors ${
                    !isRated
                      ? "bg-[#a8b3bc]/10 border-[#a8b3bc]/50 text-[#a8b3bc]"
                      : "bg-[#001e2b] border-[#3d4f5b] text-[#5c6c7a] hover:border-[#5c6c7a]"
                  }`}
                >
                  <div className="font-semibold">Unrated</div>
                  <div className="text-xs opacity-70 mt-0.5">Practice only</div>
                </button>
              </div>
            </div>

            <Button
              onClick={handleCreate}
              disabled={creating}
              className="w-full h-11 bg-[#00ed64] text-[#001e2b] font-semibold rounded-full hover:bg-[#00b545] transition-colors"
            >
              {creating ? "Creating…" : "Create Challenge Link"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div className="bg-[#001e2b] rounded-lg p-4 text-center">
              <p className="text-[#5c6c7a] text-xs mb-1">Challenge code</p>
              <p className="text-[#00ed64] font-mono text-2xl font-bold tracking-widest uppercase">
                {code}
              </p>
              <p className="text-[#5c6c7a] text-xs mt-1">{isRated ? "Rated match" : "Unrated match"}</p>
            </div>

            <Button
              onClick={handleCopy}
              className="w-full h-11 bg-[#1c2d38] border border-[#3d4f5b] text-white font-semibold rounded-full hover:bg-[#003d4f] transition-colors flex items-center gap-2"
            >
              {copied ? <Check size={16} className="text-[#00ed64]" /> : <Copy size={16} />}
              {copied ? "Copied!" : "Copy invite link"}
            </Button>

            <div className="flex items-center justify-center gap-1.5 text-xs">
              <Clock size={12} className={secondsLeft <= 60 ? "text-red-400" : "text-[#5c6c7a]"} />
              {secondsLeft > 0 ? (
                <span className={secondsLeft <= 60 ? "text-red-400 font-medium" : "text-[#5c6c7a]"}>
                  Expires in {fmtTime(secondsLeft)}
                </span>
              ) : (
                <span className="text-red-400 font-medium">Link expired</span>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
