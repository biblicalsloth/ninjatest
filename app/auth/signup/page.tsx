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
    <div className="min-h-screen flex items-center justify-center bg-[#073b4c] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#06d6a0] flex items-center justify-center">
              <span className="text-[#073b4c] font-bold text-sm">N</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#7ab5cc] text-sm">Create your account</p>
        </div>

        <div className="bg-[#0a4f66] rounded-xl border border-[#1a6080] p-6">
          <form onSubmit={handleSignup} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-[#c5e8f0] text-sm">Username</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="ninja_coder"
                required
                minLength={3}
                maxLength={20}
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
              />
              <p className="text-[#7ab5cc] text-xs">3–20 chars, letters/numbers/underscores</p>
            </div>

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
                minLength={8}
                className="bg-[#073b4c] border-[#2a7a9a] text-white placeholder:text-[#4a8fa8] h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] transition-colors disabled:opacity-50"
            >
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-[#7ab5cc] text-sm">
              Already have one?{" "}
              <Link href="/auth/login" className="text-[#06d6a0] hover:text-[#05b088] transition-colors">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
