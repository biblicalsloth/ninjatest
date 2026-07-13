"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { NinjaLogo } from "@/components/ninja-logo";

// Mirrors components/auth-panel.tsx: solid mint #06d6a0 backdrop, dark-ink
// inputs, dark button with mint label. A 3-step post-signup survey that writes
// to profiles via the complete_onboarding RPC (server-authoritative).
const EXAMS = ["CAT", "XAT", "SNAP", "NMAT", "CMAT", "GMAT", "Other"] as const;
const YEAR = new Date().getFullYear();
const YEARS = [YEAR, YEAR + 1, YEAR + 2, YEAR + 3];

const inputCls =
  "w-full h-11 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/40 text-sm outline-none focus:border-[#120F17]/50 transition-all";

export default function OnboardingClient({
  initialName,
  initialUsername,
}: {
  initialName: string;
  initialUsername: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initialName);
  const [username, setUsername] = useState(initialUsername);
  const [exam, setExam] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  function next() {
    if (step === 0) {
      if (name.trim().length < 1) { toast.error("Enter your name"); return; }
      if (username.length < 3) { toast.error("Username must be at least 3 characters"); return; }
    }
    if (step === 1 && !exam) { toast.error("Pick an exam"); return; }
    setStep((s) => s + 1);
  }

  async function finish() {
    if (!year) { toast.error("Pick a year"); return; }
    setLoading(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("complete_onboarding", {
      p_display_name: name.trim(),
      p_username: username,
      p_exam: exam,
      p_exam_year: year,
    });
    if (error) { toast.error(error.message); setLoading(false); return; }
    router.push("/lobby");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06d6a0] px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[#120F17] flex items-center justify-center overflow-hidden">
              <NinjaLogo color="#06d6a0" className="w-5 h-5" />
            </div>
            <span className="text-[#120F17] font-bold text-xl tracking-tight">Ninjatest</span>
          </div>
          <p className="text-[#120F17]/60 text-sm">Let&apos;s set up your profile.</p>
        </div>

        {/* progress dots */}
        <div className="flex justify-center gap-2 mb-6">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-[#120F17]" : "w-1.5 bg-[#120F17]/30"}`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Your name" maxLength={40} className={inputCls}
            />
            <input
              type="text" value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="Username" minLength={3} maxLength={20} className={inputCls}
            />
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="text-[#120F17] text-sm font-semibold mb-3 text-center">Which exam are you appearing for?</p>
            <div className="grid grid-cols-2 gap-2">
              {EXAMS.map((x) => (
                <button
                  key={x} type="button" onClick={() => setExam(x)}
                  className={`h-11 rounded-xl text-sm font-semibold transition-all ${exam === x ? "bg-[#120F17] text-[#06d6a0]" : "bg-[#120F17]/10 text-[#120F17] hover:bg-[#120F17]/20"}`}
                >{x}</button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="text-[#120F17] text-sm font-semibold mb-3 text-center">Target year?</p>
            <div className="grid grid-cols-2 gap-2">
              {YEARS.map((y) => (
                <button
                  key={y} type="button" onClick={() => setYear(y)}
                  className={`h-11 rounded-xl text-sm font-semibold transition-all ${year === y ? "bg-[#120F17] text-[#06d6a0]" : "bg-[#120F17]/10 text-[#120F17] hover:bg-[#120F17]/20"}`}
                >{y}</button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-6">
          {step > 0 && (
            <button
              type="button" onClick={() => setStep((s) => s - 1)} disabled={loading}
              className="h-11 px-5 rounded-full bg-[#120F17]/10 text-[#120F17] font-semibold text-sm hover:bg-[#120F17]/20 transition-colors disabled:opacity-50"
            >Back</button>
          )}
          <button
            type="button"
            onClick={step === 2 ? finish : next}
            disabled={loading}
            className="flex-1 h-11 bg-[#120F17] text-[#06d6a0] font-bold text-sm rounded-full hover:bg-[#120F17]/80 transition-colors disabled:opacity-50"
          >
            {loading ? "…" : step === 2 ? "Enter the arena →" : "Continue →"}
          </button>
        </div>
      </div>
    </div>
  );
}
