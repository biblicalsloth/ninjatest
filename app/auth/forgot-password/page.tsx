"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { NinjatestLogo } from "@/components/ninja-logo";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset-password`,
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#073b4c] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <NinjatestLogo className="mb-2" />
          <p className="text-[#7ab5cc] text-sm">Reset your password</p>
        </div>

        <div className="bg-[#0a4f66] rounded-xl border border-[#1a6080] p-6">
          {sent ? (
            <div className="text-center space-y-4 py-2">
              <CheckCircle className="mx-auto text-[#06d6a0]" size={40} />
              <h2 className="text-white font-semibold text-lg">Check your inbox</h2>
              <p className="text-[#7ab5cc] text-sm">
                Sent a password reset link to <span className="text-white">{email}</span>.
                It expires in 1 hour.
              </p>
              <Link href="/auth/login" className="text-[#06d6a0] text-sm hover:text-[#05b088] transition-colors">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-[#c5e8f0] text-sm">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
                />
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="w-full h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] transition-colors disabled:opacity-50"
              >
                {loading ? "Sending…" : "Send reset link"}
              </Button>
              <div className="text-center">
                <Link href="/auth/login" className="text-[#7ab5cc] text-sm hover:text-white transition-colors">
                  Back to sign in
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
