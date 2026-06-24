"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords don't match");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    toast.success("Password updated!");
    router.push("/lobby");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#073b4c] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#06d6a0] flex items-center justify-center">
              <span className="text-[#073b4c] font-bold text-sm">N</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#7ab5cc] text-sm">Set a new password</p>
        </div>

        <div className="bg-[#0a4f66] rounded-xl border border-[#1a6080] p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[#c5e8f0] text-sm">New password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm" className="text-[#c5e8f0] text-sm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] transition-colors disabled:opacity-50"
            >
              {loading ? "Updating…" : "Set new password"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
