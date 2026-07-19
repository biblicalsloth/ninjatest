"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, Clock, Mail } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useChallengeAccepted } from "@/lib/hooks/use-challenge-accepted";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

type SectionMode = "VARC" | "DILR" | "QUANT" | null;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const SECTION_MODES: { value: SectionMode; label: string }[] = [
  { value: null, label: "Mixed" },
  { value: "VARC", label: "VARC" },
  { value: "DILR", label: "DILR" },
  { value: "QUANT", label: "Quant" },
];

export function ChallengeDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [isRated, setIsRated] = useState(true);
  const [sectionMode, setSectionMode] = useState<SectionMode>(null);
  const [code, setCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Route the host into the match the moment the friend accepts.
  useChallengeAccepted(open ? code : null);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  async function handleCreate() {
    setCreating(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("create_challenge", {
      p_is_rated: isRated,
      p_section_mode: sectionMode,
    });
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

  async function handleSendEmail() {
    if (!code || !inviteEmail) return;
    setSendingEmail(true);
    try {
      const res = await fetch("/api/email/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: inviteEmail, code, is_rated: isRated }),
      });
      if (!res.ok) throw new Error();
      setEmailSent(true);
      toast.success("Invite sent!");
    } catch {
      toast.error("Failed to send email");
    } finally {
      setSendingEmail(false);
    }
  }

  function handleJoin() {
    // Codes are lowercase hex; the display renders them uppercase, so
    // normalize whatever the friend typed before routing.
    const c = joinCode.trim().toLowerCase();
    if (!c) return;
    router.push(`/c/${c}`);
  }

  function handleClose() {
    setCode(null);
    setIsRated(true);
    setSectionMode(null);
    setSecondsLeft(0);
    setInviteEmail("");
    setEmailSent(false);
    setJoinCode("");
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
      <DialogContent className="bg-[#111111] border-[#333333] text-white max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-white">Challenge a Friend</DialogTitle>
          <DialogDescription className="text-[#7ab5cc]">
            Share a link for a 1v1 match. Link expires in 15 minutes.
          </DialogDescription>
        </DialogHeader>

        {!code ? (
          <div className="space-y-5 pt-2">
            {/* Rated toggle */}
            <div>
              <Label className="text-[#c5e8f0] text-sm mb-3 block">Match type</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setIsRated(true)}
                  className={`rounded-lg px-4 py-3 text-sm font-medium border transition-colors ${
                    isRated
                      ? "bg-[#06d6a0]/10 border-[#06d6a0]/50 text-[#06d6a0]"
                      : "bg-[#120F17] border-[#333333] text-[#7ab5cc] hover:border-[#4a8fa8]"
                  }`}
                >
                  <div className="font-semibold">Rated</div>
                  <div className="text-xs opacity-70 mt-0.5">ELO changes</div>
                </button>
                <button
                  onClick={() => setIsRated(false)}
                  className={`rounded-lg px-4 py-3 text-sm font-medium border transition-colors ${
                    !isRated
                      ? "bg-[#c5e8f0]/10 border-[#c5e8f0]/50 text-[#c5e8f0]"
                      : "bg-[#120F17] border-[#333333] text-[#7ab5cc] hover:border-[#4a8fa8]"
                  }`}
                >
                  <div className="font-semibold">Unrated</div>
                  <div className="text-xs opacity-70 mt-0.5">Practice only</div>
                </button>
              </div>
            </div>

            {/* Section mode */}
            <div>
              <Label className="text-[#c5e8f0] text-sm mb-3 block">Sections</Label>
              <div className="grid grid-cols-4 gap-2">
                {SECTION_MODES.map((m) => (
                  <button
                    key={m.label}
                    onClick={() => setSectionMode(m.value)}
                    className={`rounded-lg px-2 py-2.5 text-xs font-semibold border transition-colors ${
                      sectionMode === m.value
                        ? "bg-[#06d6a0]/10 border-[#06d6a0]/50 text-[#06d6a0]"
                        : "bg-[#120F17] border-[#333333] text-[#7ab5cc] hover:border-[#4a8fa8]"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <Button
              onClick={handleCreate}
              disabled={creating}
              className="w-full h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] transition-colors"
            >
              {creating ? "Creating…" : "Create Challenge Link"}
            </Button>

            {/* Join with a friend's code */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-[#333333]" />
              <span className="text-[#7ab5cc] text-xs">or join with a code</span>
              <div className="flex-1 h-px bg-[#333333]" />
            </div>
            <div className="flex gap-2">
              <Input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleJoin(); }}
                placeholder="Enter challenge code"
                className="bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] h-11 font-mono tracking-widest uppercase flex-1"
              />
              <Button
                onClick={handleJoin}
                disabled={!joinCode.trim()}
                className="h-11 px-5 bg-[#06d6a0]/10 border border-[#06d6a0]/30 text-[#06d6a0] hover:bg-[#06d6a0]/20 font-semibold rounded-full shrink-0"
              >
                Join
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div className="bg-[#120F17] rounded-lg p-4 text-center">
              <p className="text-[#7ab5cc] text-xs mb-1">Challenge code</p>
              <p className="text-[#06d6a0] font-mono text-2xl font-bold tracking-widest uppercase">
                {code}
              </p>
              <p className="text-[#7ab5cc] text-xs mt-1">
                {isRated ? "Rated match" : "Unrated match"}
                {sectionMode ? ` · ${sectionMode} only` : " · Mixed sections"}
              </p>
            </div>

            <Button
              onClick={handleCopy}
              className="w-full h-11 bg-[#111111] border border-[#333333] text-white font-semibold rounded-full hover:bg-[#1c1c1c] transition-colors flex items-center gap-2"
            >
              {copied ? <Check size={16} className="text-[#06d6a0]" /> : <Copy size={16} />}
              {copied ? "Copied!" : "Copy invite link"}
            </Button>

            {/* Email invite */}
            <div className="space-y-2">
              <Label className="text-[#7ab5cc] text-xs">Or invite by email</Label>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="friend@example.com"
                  value={inviteEmail}
                  onChange={(e) => { setInviteEmail(e.target.value); setEmailSent(false); }}
                  className="bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] h-9 text-sm flex-1"
                />
                <Button
                  size="sm"
                  onClick={handleSendEmail}
                  disabled={sendingEmail || !inviteEmail || emailSent}
                  className="h-9 px-3 bg-[#06d6a0]/10 border border-[#06d6a0]/30 text-[#06d6a0] hover:bg-[#06d6a0]/20 shrink-0"
                >
                  {emailSent ? <Check size={14} /> : <Mail size={14} />}
                </Button>
              </div>
              {emailSent && <p className="text-[#06d6a0] text-xs">Invite sent to {inviteEmail}</p>}
            </div>

            <div className="flex items-center justify-center gap-1.5 text-xs">
              <Clock size={12} className={secondsLeft <= 60 ? "text-[#ef476f]" : "text-[#7ab5cc]"} />
              {secondsLeft > 0 ? (
                <span className={secondsLeft <= 60 ? "text-[#ef476f] font-medium" : "text-[#7ab5cc]"}>
                  Expires in {fmtTime(secondsLeft)}
                </span>
              ) : (
                <span className="text-[#ef476f] font-medium">Link expired</span>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
