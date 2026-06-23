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
    <div className="min-h-screen flex items-center justify-center bg-[#001e2b] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#00ed64] flex items-center justify-center">
              <span className="text-[#001e2b] font-bold text-sm">N</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#a8b3bc] text-sm">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-[#1c2d38] rounded-xl border border-[#1c2d38] p-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[#a8b3bc] text-sm">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="bg-[#001e2b] border-[#3d4f5b] text-white placeholder:text-[#5c6c7a] focus:border-[#00ed64] focus:ring-0 h-11"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[#a8b3bc] text-sm">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="bg-[#001e2b] border-[#3d4f5b] text-white placeholder:text-[#5c6c7a] focus:border-[#00ed64] focus:ring-0 h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#00ed64] text-[#001e2b] font-semibold rounded-full hover:bg-[#00b545] transition-colors disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-[#5c6c7a] text-sm">
              No account?{" "}
              <Link href="/auth/signup" className="text-[#00ed64] hover:text-[#00b545] transition-colors">
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
