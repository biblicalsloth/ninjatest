"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (username.length < 3) {
      toast.error("Username must be at least 3 characters");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username, display_name: username },
      },
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    toast.success("Account created! Check your email to confirm.");
    router.push("/auth/login");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#001e2b] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#00ed64] flex items-center justify-center">
              <span className="text-[#001e2b] font-bold text-sm">N</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#a8b3bc] text-sm">Create your account</p>
        </div>

        <div className="bg-[#1c2d38] rounded-xl border border-[#3d4f5b] p-6">
          <form onSubmit={handleSignup} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-[#a8b3bc] text-sm">Username</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="ninja_coder"
                required
                minLength={3}
                maxLength={20}
                className="bg-[#001e2b] border-[#3d4f5b] text-white placeholder:text-[#5c6c7a] h-11"
              />
              <p className="text-[#5c6c7a] text-xs">3–20 chars, letters/numbers/underscores</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[#a8b3bc] text-sm">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="bg-[#001e2b] border-[#3d4f5b] text-white placeholder:text-[#5c6c7a] h-11"
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
                minLength={8}
                className="bg-[#001e2b] border-[#3d4f5b] text-white placeholder:text-[#5c6c7a] h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#00ed64] text-[#001e2b] font-semibold rounded-full hover:bg-[#00b545] transition-colors disabled:opacity-50"
            >
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-[#5c6c7a] text-sm">
              Already have one?{" "}
              <Link href="/auth/login" className="text-[#00ed64] hover:text-[#00b545] transition-colors">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
