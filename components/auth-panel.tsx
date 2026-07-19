"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { NinjatestLogo } from "@/components/ninja-logo";
import { GoogleSignInButton } from "@/components/google-signin-button";

type AuthMode = "signin" | "signup";

// Mirrors the landing "PLAY" CTA panel (app/landing-client.tsx): solid mint
// #06d6a0 backdrop, dark-ink inputs, dark button with mint label. Shared by
// /auth/login and /auth/signup so all three auth surfaces read identically.
export function AuthPanel({
  defaultMode = "signin",
  next = "/exams", // every fresh login funnels through the exam picker
  callbackError = false,
}: {
  defaultMode?: AuthMode;
  next?: string;
  callbackError?: boolean;
}) {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<AuthMode>(defaultMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (callbackError) toast.error("Sign-in failed or was cancelled. Please try again.");
  }, [callbackError]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    if (authMode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { toast.error(error.message); setLoading(false); return; }
      router.push(next);
      router.refresh();
    } else {
      if (username.length < 3) { toast.error("Username must be at least 3 characters"); setLoading(false); return; }
      // Best-effort pre-check; the DB trigger resolves races with a suffix.
      const { count } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("username", username);
      if (count && count > 0) { toast.error("Username already taken"); setLoading(false); return; }
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: username } },
      });
      if (error) { toast.error(error.message); setLoading(false); return; }
      toast.success("Check your email to confirm your account!");
      setLoading(false);
    }
  }

  const inputCls =
    "w-full h-11 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/40 text-sm outline-none focus:border-[#120F17]/50 transition-all";

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06d6a0] px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" aria-label="Ninjatest home">
            <NinjatestLogo onMint className="mb-2" />
          </Link>
          <p className="text-[#120F17]/60 text-sm">{authMode === "signin" ? "Welcome back." : "Join the arena."}</p>
        </div>

        <div className="flex bg-[#120F17]/10 rounded-full p-1 mb-5">
          <button
            type="button"
            onClick={() => setAuthMode("signin")}
            className={`flex-1 py-2 text-sm font-semibold rounded-full transition-all duration-200 ${authMode === "signin" ? "bg-[#120F17] text-[#06d6a0]" : "text-[#120F17]/50 hover:text-[#120F17]"}`}
          >Sign in</button>
          <button
            type="button"
            onClick={() => setAuthMode("signup")}
            className={`flex-1 py-2 text-sm font-semibold rounded-full transition-all duration-200 ${authMode === "signup" ? "bg-[#120F17] text-[#06d6a0]" : "text-[#120F17]/50 hover:text-[#120F17]"}`}
          >Sign up</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {authMode === "signup" && (
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="Username"
              required minLength={3} maxLength={20}
              className={inputCls}
            />
          )}
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" required
            className={inputCls}
          />
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Password" required minLength={authMode === "signup" ? 8 : undefined}
            className={inputCls}
          />
          {authMode === "signin" && (
            <div className="text-right">
              <Link href="/auth/forgot-password" className="text-[#120F17]/60 text-xs hover:text-[#120F17] transition-colors">
                Forgot password?
              </Link>
            </div>
          )}
          <button
            type="submit" disabled={loading}
            className="w-full h-11 bg-[#120F17] text-[#06d6a0] font-bold text-sm rounded-full hover:bg-[#120F17]/80 transition-colors disabled:opacity-50 mt-1"
          >
            {loading ? "…" : authMode === "signin" ? "Enter the arena →" : "Create account →"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-[#120F17]/20" />
          <span className="text-[#120F17]/50 text-xs">or</span>
          <div className="flex-1 h-px bg-[#120F17]/20" />
        </div>
        <GoogleSignInButton next={next} />

        {/* Post-logout lands here via location.replace, which drops the history
            entry — the browser Back button can't reach the landing page, so an
            explicit way home is required, not a nicety. */}
        <div className="text-center mt-5">
          <Link href="/" className="text-[#120F17]/60 text-sm font-medium hover:text-[#120F17] transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
