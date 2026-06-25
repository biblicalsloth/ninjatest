"use client";

export const dynamic = "force-dynamic";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/auth/login"); return; }

      const { data: profile } = await supabase
        .from("profiles")
        .select("username, display_name, avatar_url")
        .eq("id", user.id)
        .single();

      if (profile) {
        const p = profile as { username: string; display_name: string | null; avatar_url: string | null };
        setUserId(user.id);
        setUsername(p.username);
        setDisplayName(p.display_name ?? "");
        setAvatarUrl(p.avatar_url);
      }
      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  if (loading) {
    return (
      <div className="min-h-screen bg-[#120F17] flex items-center justify-center">
        <Loader2 className="text-[#06d6a0] animate-spin" size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center">
          <Link href={`/profile/${username}`} className="text-[#7ab5cc] hover:text-white flex items-center gap-1.5 text-sm transition-colors">
            <ArrowLeft size={14} />
            Back
          </Link>
          <h1 className="text-white font-semibold mx-auto">Settings</h1>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-8 space-y-6">

        {/* Avatar */}
        <section className="bg-[#111111] rounded-xl p-6">
          <h2 className="text-[#7ab5cc] text-sm font-medium mb-4">Profile photo</h2>
          <div className="flex items-center gap-5">
            <div className="relative">
              <Avatar className="w-20 h-20">
                <AvatarImage src={avatarUrl ?? undefined} />
                <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-2xl font-bold">
                  {username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {uploadingAvatar && (
                <div className="absolute inset-0 rounded-full bg-[#120F17]/60 flex items-center justify-center">
                  <Loader2 className="text-white animate-spin" size={18} />
                </div>
              )}
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={handleAvatarChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="border-[#333333] text-[#c5e8f0] hover:text-white hover:bg-[#111111] flex items-center gap-1.5"
              >
                <Camera size={14} />
                Change photo
              </Button>
              <p className="text-[#4a8fa8] text-xs mt-1.5">JPG, PNG, WebP · max 2 MB</p>
            </div>
          </div>
        </section>

        {/* Profile info */}
        <section className="bg-[#111111] rounded-xl p-6 space-y-4">
          <h2 className="text-[#7ab5cc] text-sm font-medium">Profile info</h2>
          <div className="space-y-1">
            <Label className="text-[#7ab5cc] text-xs">Username</Label>
            <Input
              value={username}
              disabled
              className="bg-[#120F17] border-[#333333] text-[#4a8fa8] cursor-not-allowed"
            />
            <p className="text-[#4a8fa8] text-xs">Username cannot be changed.</p>
          </div>
          <div className="space-y-1">
            <Label className="text-[#7ab5cc] text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How you appear to others"
              className="bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] focus:border-[#06d6a0]"
            />
          </div>
          <Button
            onClick={handleSaveProfile}
            disabled={saving}
            className="bg-[#06d6a0] text-[#073b4c] font-semibold rounded-lg hover:bg-[#05b088]"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </section>

        {/* Password */}
        <section className="bg-[#111111] rounded-xl p-6 space-y-4">
          <h2 className="text-[#7ab5cc] text-sm font-medium">Change password</h2>
          <div className="space-y-1">
            <Label className="text-[#7ab5cc] text-xs">New password</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 8 characters"
              className="bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] focus:border-[#06d6a0]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[#7ab5cc] text-xs">Confirm new password</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              className="bg-[#120F17] border-[#333333] text-white placeholder:text-[#4a8fa8] focus:border-[#06d6a0]"
            />
          </div>
          <Button
            onClick={handleChangePassword}
            disabled={saving || !newPassword}
            variant="outline"
            className="border-[#333333] text-white hover:bg-[#111111] rounded-lg"
          >
            {saving ? "Updating…" : "Update password"}
          </Button>
        </section>
      </main>
    </div>
  );
}
