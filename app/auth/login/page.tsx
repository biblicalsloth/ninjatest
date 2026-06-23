"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center bg-[#073b4c] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#06d6a0] flex items-center justify-center">
              <span className="text-[#073b4c] font-bold text-sm">N</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#7ab5cc] text-sm">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-[#0a4f66] rounded-xl border border-[#1a6080] p-6">
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
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[#c5e8f0] text-sm">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
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

          <div className="mt-4 text-center">
            <p className="text-[#7ab5cc] text-sm">
              No account?{" "}
              <Link href="/auth/signup" className="text-[#06d6a0] hover:text-[#05b088] transition-colors">
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
