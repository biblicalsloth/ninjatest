"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Camera,
  KeyRound,
  Loader2,
  LogOut,
  SlidersHorizontal,
  User,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/page-header";
import { getLeague } from "@/lib/leagues";

/* ------------------------------------------------------------------ */
/* Client-side preferences — localStorage ONLY, never sent to the      */
/* server. No schema, no RPC; purely cosmetic/UX toggles.              */
/* ------------------------------------------------------------------ */
const PREF_KEYS = {
  sound: "ninjatest:pref:sound",
  matchNotify: "ninjatest:pref:match-notify",
  lbHighlight: "ninjatest:pref:lb-highlight",
} as const;

function readPref(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(key);
  return v === null ? fallback : v === "1";
}

/* Minimal switch — ponytail: hand-rolled to avoid adding @radix-ui/react-switch */
function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onCheckedChange(!checked)}
      className={`relative w-10 h-6 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-[#06d6a0]" : "bg-[#333333]"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/* Shared card shell: icon tile + title + muted description, divider, rows. */
function SettingsCard({
  id,
  icon,
  title,
  desc,
  danger,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-6 bg-[#111111] rounded-xl border transition-colors ${
        danger
          ? "border-[#ef476f]/30 hover:border-[#ef476f]/50"
          : "border-[#333333]/60 hover:border-[#333333]"
      }`}
    >
      <div className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-lg bg-[#120F17] flex items-center justify-center ${
              danger ? "text-[#ef476f]" : "text-[#06d6a0]"
            }`}
          >
            {icon}
          </div>
          <div>
            <h2 className={`text-sm font-medium ${danger ? "text-[#ef476f]" : "text-white"}`}>
              {title}
            </h2>
            <p className="text-[#4a8fa8] text-xs mt-0.5">{desc}</p>
          </div>
        </div>
      </div>
      <div className={`border-t ${danger ? "border-[#ef476f]/20" : "border-[#333333]/60"}`} />
      <div className="p-6 pt-5 space-y-5">{children}</div>
    </section>
  );
}

/* Label + control on a shared grid so every row aligns. */
function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-4">
      <div>
        <Label className="text-[#7ab5cc] text-xs">{label}</Label>
        {hint && <p className="text-[#4a8fa8] text-xs mt-0.5 hidden sm:block">{hint}</p>}
      </div>
      <div className="min-w-0">
        {children}
        {hint && <p className="text-[#4a8fa8] text-xs mt-1 sm:hidden">{hint}</p>}
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "account", label: "Account" },
  { id: "preferences", label: "Preferences" },
  { id: "danger", label: "Danger zone" },
] as const;

export default function SettingsClient() {
  const router = useRouter();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [elo, setElo] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [activeSection, setActiveSection] = useState<string>("profile");

  // Client-side prefs (localStorage only — see PREF_KEYS note above).
  // Lazy init is hydration-safe: first paint is the loading spinner.
  const [soundOn, setSoundOn] = useState(() => readPref(PREF_KEYS.sound, true));
  const [matchNotify, setMatchNotify] = useState(() => readPref(PREF_KEYS.matchNotify, true));
  const [lbHighlight, setLbHighlight] = useState(() => readPref(PREF_KEYS.lbHighlight, true));

  function setPref(key: string, set: (v: boolean) => void) {
    return (v: boolean) => {
      set(v);
      window.localStorage.setItem(key, v ? "1" : "0");
    };
  }

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/auth/login"); return; }

      const { data: profile } = await supabase
        .from("profiles")
        .select("username, display_name, avatar_url, elo")
        .eq("id", user.id)
        .single();

      if (profile) {
        const p = profile as { username: string; display_name: string | null; avatar_url: string | null; elo: number };
        setUserId(user.id);
        setEmail(user.email ?? "");
        setUsername(p.username);
        setDisplayName(p.display_name ?? "");
        setAvatarUrl(p.avatar_url);
        setElo(p.elo);
      }
      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll-spy for the left rail
  useEffect(() => {
    if (loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSection(e.target.id);
        }
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  async function handleSaveProfile() {
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("profiles")
      .update({ display_name: displayName || null })
      .eq("id", userId);

    if (error) toast.error("Failed to save: " + error.message);
    else toast.success("Profile updated");
    setSaving(false);
  }

  async function handleChangePassword() {
    if (!newPassword) return;
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) toast.error("Failed to change password: " + error.message);
    else {
      toast.success("Password changed");
      setNewPassword("");
      setConfirmPassword("");
    }
    setSaving(false);
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !userId) return;

    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be under 2 MB");
      return;
    }

    setUploadingAvatar(true);
    const ext = file.name.split(".").pop();
    const path = `${userId}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true });

    if (uploadError) {
      toast.error("Upload failed: " + uploadError.message);
      setUploadingAvatar(false);
      return;
    }

    const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
    const urlWithBust = `${publicUrl}?t=${Date.now()}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("profiles").update({ avatar_url: urlWithBust }).eq("id", userId);
    setAvatarUrl(urlWithBust);
    toast.success("Avatar updated");
    setUploadingAvatar(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/auth/login");
  }

  async function handleSignOutEverywhere() {
    const { error } = await supabase.auth.signOut({ scope: "global" });
    if (error) {
      toast.error("Failed to sign out: " + error.message);
      return;
    }
    router.push("/auth/login");
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#120F17] flex items-center justify-center">
        <Loader2 className="text-[#06d6a0] animate-spin" size={24} />
      </div>
    );
  }

  const league = elo !== null ? getLeague(elo) : null;
  const inputCls =
    "bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] focus:border-[#06d6a0]";

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <div className="max-w-4xl mx-auto px-4 pt-6">
        <PageHeader label="Settings" sub="Manage your profile, account and preferences" />
      </div>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Profile summary header card */}
        <section className="bg-[#111111] rounded-xl border border-[#333333]/60 p-6 mb-8">
          <div className="flex items-center gap-5">
            <div className="relative group shrink-0">
              <Avatar className="w-24 h-24">
                <AvatarImage src={avatarUrl ?? undefined} />
                <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-3xl font-bold">
                  {username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={handleAvatarChange}
              />
              <button
                type="button"
                aria-label="Change photo"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="absolute inset-0 rounded-full bg-[#120F17]/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
              >
                {uploadingAvatar ? (
                  <Loader2 className="text-white animate-spin" size={20} />
                ) : (
                  <Camera className="text-white" size={20} />
                )}
              </button>
            </div>
            <div className="min-w-0">
              <h2 className="font-pixel text-lg text-white truncate">
                {displayName || username}
              </h2>
              <p className="text-[#7ab5cc] text-sm truncate">@{username}</p>
              {league && elo !== null && (
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full border"
                    style={{ color: league.color, borderColor: `${league.color}66` }}
                  >
                    {league.name}
                  </span>
                  <span className="font-mono text-sm text-[#ffd166]">{elo}</span>
                </div>
              )}
              <p className="text-[#4a8fa8] text-xs mt-2">
                Hover the photo to change it · JPG, PNG, WebP · max 2 MB
              </p>
            </div>
          </div>
        </section>

        <div className="lg:grid lg:grid-cols-[11rem_1fr] lg:gap-8 lg:items-start">
          {/* Left rail */}
          <nav className="hidden lg:block sticky top-6 space-y-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() =>
                  document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth" })
                }
                className={`w-full text-left text-sm rounded-lg px-3 py-2 transition-colors border-l-2 ${
                  activeSection === s.id
                    ? "border-[#06d6a0] text-white bg-[#111111]"
                    : "border-transparent text-[#7ab5cc] hover:text-white hover:bg-[#111111]/60"
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          {/* Content column */}
          <div className="space-y-6">
            <SettingsCard
              id="profile"
              icon={<User size={16} />}
              title="Profile"
              desc="How you appear to other players"
            >
              <SettingsRow label="Username" hint="Cannot be changed">
                <div className="flex items-center h-9 px-3 rounded-md bg-[#120F17]/60 border border-[#333333]/60 text-[#4a8fa8] text-sm font-mono">
                  @{username}
                </div>
              </SettingsRow>
              <SettingsRow label="Display name">
                <div className="flex gap-2">
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="How you appear to others"
                    className={inputCls}
                  />
                  <Button
                    onClick={handleSaveProfile}
                    disabled={saving}
                    className="bg-[#06d6a0] text-[#073b4c] font-semibold rounded-lg hover:bg-[#05b088] shrink-0"
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsCard>

            <SettingsCard
              id="account"
              icon={<KeyRound size={16} />}
              title="Account"
              desc="Sign-in email and password"
            >
              <SettingsRow label="Email" hint="Your sign-in email">
                <div className="flex items-center h-9 px-3 rounded-md bg-[#120F17]/60 border border-[#333333]/60 text-[#4a8fa8] text-sm">
                  {email}
                </div>
              </SettingsRow>
              <SettingsRow label="New password">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  className={inputCls}
                />
              </SettingsRow>
              <SettingsRow label="Confirm password">
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  className={inputCls}
                />
              </SettingsRow>
              <div className="flex items-center justify-between pt-1">
                <Button
                  onClick={handleChangePassword}
                  disabled={saving || !newPassword}
                  variant="outline"
                  className="border-[#333333] text-white hover:bg-[#111111] rounded-lg"
                >
                  {saving ? "Updating…" : "Update password"}
                </Button>
                <Button
                  onClick={handleSignOut}
                  variant="outline"
                  className="border-[#333333] text-[#c5e8f0] hover:text-white hover:bg-[#111111] rounded-lg flex items-center gap-1.5"
                >
                  <LogOut size={14} />
                  Sign out
                </Button>
              </div>
            </SettingsCard>

            <SettingsCard
              id="preferences"
              icon={<SlidersHorizontal size={16} />}
              title="Preferences"
              desc="Stored on this device only"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-white">Sound effects</p>
                  <p className="text-[#4a8fa8] text-xs mt-0.5">Play sounds during matches</p>
                </div>
                <Switch checked={soundOn} onCheckedChange={setPref(PREF_KEYS.sound, setSoundOn)} label="Sound effects" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-white">Match found notification</p>
                  <p className="text-[#4a8fa8] text-xs mt-0.5">Notify when an opponent is found</p>
                </div>
                <Switch checked={matchNotify} onCheckedChange={setPref(PREF_KEYS.matchNotify, setMatchNotify)} label="Match found notification" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-white">Leaderboard highlight</p>
                  <p className="text-[#4a8fa8] text-xs mt-0.5">Highlight your row on the leaderboard</p>
                </div>
                <Switch checked={lbHighlight} onCheckedChange={setPref(PREF_KEYS.lbHighlight, setLbHighlight)} label="Leaderboard highlight" />
              </div>
            </SettingsCard>

            <SettingsCard
              id="danger"
              icon={<AlertTriangle size={16} />}
              title="Danger zone"
              desc="Session-wide actions"
              danger
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-white">Sign out everywhere</p>
                  <p className="text-[#4a8fa8] text-xs mt-0.5">
                    Ends your session on every device, including this one
                  </p>
                </div>
                <Button
                  onClick={handleSignOutEverywhere}
                  variant="outline"
                  className="border-[#ef476f]/50 text-[#ef476f] hover:bg-[#ef476f]/10 hover:text-[#ef476f] rounded-lg shrink-0"
                >
                  Sign out everywhere
                </Button>
              </div>
            </SettingsCard>
          </div>
        </div>
      </main>
    </div>
  );
}
