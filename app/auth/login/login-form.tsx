"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/google-signin-button";
import { NinjaLogo } from "@/components/ninja-logo";

export default function LoginForm({ callbackError }: { callbackError?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (callbackError) toast.error("Sign-in failed. Please try again.");
  }, [callbackError]);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    router.push("/lobby");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#120F17] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#06d6a0] flex items-center justify-center overflow-hidden">
              <NinjaLogo color="#120F17" className="w-5 h-5" />
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#7ab5cc] text-sm">Sign in to your account</p>
        </div>

        <div className="bg-[#111111] rounded-xl border border-[#222222] p-6">
          {callbackError && (
            <div className="mb-4 rounded-lg border border-[#ef476f]/30 bg-[#ef476f]/10 px-3 py-2 text-[#ef476f] text-xs">
              Sign-in failed or was cancelled. Please try again.
            </div>
          )}

          <GoogleSignInButton />

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-[#222222]" />
            <span className="text-[#4a8fa8] text-xs">or</span>
            <div className="flex-1 h-px bg-[#222222]" />
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[#c5e8f0] text-sm">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="bg-black border-[#333333] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-[#c5e8f0] text-sm">Password</Label>
                <Link href="/auth/forgot-password" className="text-[#7ab5cc] text-xs hover:text-white transition-colors">
                  Forgot?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="bg-black border-[#333333] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] transition-colors disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="text-center text-[#7ab5cc] text-sm mt-5">
          No account?{" "}
          <Link href="/auth/signup" className="text-[#06d6a0] hover:underline">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
