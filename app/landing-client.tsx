"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { NinjaLogo } from "@/components/ninja-logo";
import { GoogleSignInButton } from "@/components/google-signin-button";
import dynamic from "next/dynamic";

const Grainient = dynamic(() => import("@/components/Grainient"), { ssr: false });

const IS_WAITLIST = process.env.NEXT_PUBLIC_APP_MODE === "waitlist";

/* ── Airport-board flip word ── */
const EXAMS = ["CAT", "XAT", "GMAT", "SSC", "Bank", "JEE", "NEET"];
function FlipTile({ word }: { word: string }) {
  return (
    <span style={{ display: "inline-block", color: "#06d6a0", animation: "examFlip 0.32s cubic-bezier(0.22,1,0.36,1)" }}>
      {word}
    </span>
  );
}
function FlipWord() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % EXAMS.length), 1100);
    return () => clearInterval(id);
  }, []);
  return <FlipTile key={idx} word={EXAMS[idx]} />;
}

/* ── Survey questions ── */
type Answer = { name: string; email: string; phone: string; year: string; percentile: string; section: string };
const QUESTIONS = [
  { id: "name" as const,       label: "What's your name?",           type: "text",   placeholder: "Your name" },
  { id: "email" as const,      label: "Email address?",              type: "email",  placeholder: "you@example.com" },
  { id: "phone" as const,      label: "Phone number?",               type: "tel",    placeholder: "+91 98765 43210" },
  { id: "year" as const,       label: "CAT target year?",            type: "select", options: ["2025", "2026", "2027", "2028"] },
  { id: "percentile" as const, label: "Current mock percentile?",    type: "select", options: ["<50", "50–70", "70–85", "85–95", "95+"] },
  { id: "section" as const,    label: "Which section haunts you?",   type: "pills",  options: ["VARC", "DILR", "Quant"] },
] as const;

type Phase = "idle" | "expanding" | "open";
type AuthMode = "signin" | "signup";

export default function LandingClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const scrollRef = useRef<HTMLDivElement>(null);

  /* auth state (live mode only) */
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const router = useRouter();

  /* survey state (waitlist mode only) */
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answer>({ name: "", email: "", phone: "", year: "", percentile: "", section: "" });
  const [surveyDone, setSurveyDone] = useState(false);
  const [surveyLoading, setSurveyLoading] = useState(false);
  const [surveyError, setSurveyError] = useState<string | null>(null);

  // Live online count is intentionally NOT subscribed on the public landing
  // page: it would open a Supabase Realtime WebSocket for every anonymous
  // visitor (incl. bots/crawlers), the top concurrent-connection / billing
  // risk. The live count lives in the authenticated lobby instead.
  const onlineCount: number | null = null;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const c = container;
    let rafId: number;
    function update() {
      const els = c.querySelectorAll<HTMLElement>("[data-parallax]");
      const vh = window.innerHeight;
      els.forEach(el => {
        const speed = parseFloat(el.dataset.parallax ?? "0.06");
        const rect = el.getBoundingClientRect();
        el.style.transform = `translateY(${(rect.top + rect.height / 2 - vh / 2) * speed}px)`;
      });
    }
    function onScroll() { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(update); }
    c.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { c.removeEventListener("scroll", onScroll); cancelAnimationFrame(rafId); };
  }, []);

  function handleOpen() {
    setPhase("expanding");
    setTimeout(() => setPhase("open"), 550);
  }
  function handleBack() {
    setPhase("expanding");
    setTimeout(() => {
      setPhase("idle");
      setStep(0);
      setAnswers({ name: "", email: "", phone: "", year: "", percentile: "", section: "" });
      setSurveyError(null);
      setEmail(""); setPassword(""); setUsername("");
    }, 550);
  }

  /* auth submit */
  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    const supabase = createClient();
    if (authMode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { toast.error(error.message); setAuthLoading(false); return; }
      router.push("/lobby");
    } else {
      if (username.length < 3) { toast.error("Username must be at least 3 characters"); setAuthLoading(false); return; }
      const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("username", username);
      if (count && count > 0) { toast.error("Username already taken"); setAuthLoading(false); return; }
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { username, display_name: username } } });
      if (error) { toast.error(error.message); setAuthLoading(false); return; }
      toast.success("Check your email to confirm your account!");
      setAuthLoading(false);
    }
  }

  /* survey next / submit */
  function currentValue() { return answers[QUESTIONS[step].id]; }

  function handleNext() {
    if (!currentValue().trim()) return;
    setSurveyError(null);
    if (step < QUESTIONS.length - 1) { setStep(s => s + 1); }
  }

  async function handleSurveySubmit() {
    if (!currentValue().trim()) return;
    setSurveyLoading(true);
    setSurveyError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSurveyError((body as { error?: string }).error ?? "Something went wrong");
        setSurveyLoading(false);
        return;
      }
      setSurveyDone(true);
    } catch {
      setSurveyError("Network error. Try again.");
    }
    setSurveyLoading(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (step < QUESTIONS.length - 1) handleNext();
      else handleSurveySubmit();
    }
  }

  const isIdle = phase === "idle";
  const isOpen = phase === "open";
  const q = QUESTIONS[step];

  return (
    <div className="flex h-screen bg-[#120F17] overflow-hidden" style={{ width: "100vw" }}>

      {/* ── Left: scrollable landing ── */}
      <div
        className="relative shrink-0 overflow-hidden text-white h-screen"
        style={{
          width: isIdle ? "80vw" : "0vw",
          opacity: isIdle ? 1 : 0,
          transition: "width 500ms ease-in-out, opacity 200ms ease-in-out",
        }}
      >
        <div className="absolute inset-0 pointer-events-none">
          <Grainient
            color1="#120F17" color2="#120F17" color3="#9f84bd"
            timeSpeed={0.45} colorBalance={-0.2} warpStrength={0.6}
            warpFrequency={5} warpSpeed={2} warpAmplitude={50}
            blendAngle={0} blendSoftness={0.05} rotationAmount={500}
            noiseScale={2} grainAmount={0.1} grainScale={2}
            grainAnimated={false} contrast={1.5} gamma={1} saturation={1}
            centerX={0} centerY={0} zoom={0.9}
          />
        </div>

        <div ref={scrollRef} className="relative h-full overflow-y-auto overflow-x-hidden no-scrollbar" style={{ zIndex: 1 }}>

          {/* Nav */}
          <nav className="px-10 pt-8 flex items-center justify-between sticky top-0 bg-[#120F17]/60 backdrop-blur-sm z-10 py-5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[#06d6a0] flex items-center justify-center shrink-0 overflow-hidden">
                <NinjaLogo color="#120F17" className="w-5 h-5" />
              </div>
              <span className="font-semibold tracking-tight">Ninjatest</span>
            </div>
            <div className="flex items-center gap-7">
              <a href="#how-it-works" className="text-white/45 hover:text-white text-sm transition-colors">How it works</a>
              {!IS_WAITLIST && (
                <Link href="/leaderboard" className="text-white/45 hover:text-white text-sm transition-colors">Leaderboard</Link>
              )}
              {onlineCount !== null && onlineCount > 0 && (
                <div className="flex items-center gap-1.5 bg-[#06d6a0]/10 border border-[#06d6a0]/20 rounded-full px-2.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#06d6a0] animate-pulse" />
                  <span className="text-[#06d6a0] text-xs font-medium">{onlineCount} online</span>
                </div>
              )}
              <button onClick={handleOpen} className="text-[#06d6a0] hover:text-white text-sm font-semibold transition-colors">
                {IS_WAITLIST ? "Join Waitlist →" : "Sign in →"}
              </button>
            </div>
          </nav>

          {/* Hero */}
          <section className="overflow-hidden">
            <div data-parallax="0.07" style={{ willChange: "transform" }} className="px-10 pt-16 pb-16">
              <h1 className="text-[clamp(3.2rem,6.5vw,6rem)] font-black leading-[0.88] tracking-[-0.03em] text-balance">
                <FlipWord /> prep just got<br />
                <span className="text-[#06d6a0]">1-v-1 ranked mode.</span>
              </h1>
              <p className="mt-8 text-white/50 text-lg font-light max-w-[42ch] leading-relaxed">
                1v1 battles. real rankings. the grind hits different when someone&apos;s watching.
              </p>
              <div className="mt-10 flex items-center gap-5">
                <button
                  onClick={handleOpen}
                  className="inline-flex items-center gap-2 text-[#06d6a0] font-semibold text-sm border border-[#06d6a0]/30 rounded-full px-5 py-2.5 hover:bg-[#06d6a0]/10 transition-colors"
                >
                  {IS_WAITLIST ? "join the waitlist →" : "enter the arena →"}
                </button>
                <span className="text-white/20 text-xs font-mono">9 questions · 3 sections · elo rated</span>
              </div>
              {onlineCount !== null && onlineCount > 0 && (
                <div className="mt-5 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#06d6a0] animate-pulse" />
                  <span className="text-white/40 text-sm font-mono">
                    <span className="text-[#06d6a0] font-bold">{onlineCount}</span> ninja{onlineCount !== 1 ? "s" : ""} in the arena right now
                  </span>
                </div>
              )}
            </div>
          </section>

          <LogoMarquee />

          {/* ELO */}
          <section id="elo" className="overflow-hidden min-h-[60vh] border-t border-[#9f84bd]/10">
          <div data-parallax="0.06" style={{ willChange: "transform" }} className="flex items-center gap-8 px-10 py-20">
            <div className="flex-1 min-w-0 pr-4">
              <h2 className="text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[0.9] tracking-[-0.03em] text-balance mb-6">
                your elo<br />don&apos;t lie.
              </h2>
              <p className="text-white/50 text-base leading-relaxed max-w-[40ch] mb-5">
                win a match, the number goes up. lose, it goes down. no participation trophies, no vibes-based ranking. just math.
              </p>
              <p className="text-white/30 text-sm leading-relaxed max-w-[40ch]">
                squeaked by? barely lose elo. got destroyed? that&apos;s gonna sting. the gap between you two decides everything.
              </p>
            </div>
            <div className="shrink-0 flex items-center justify-center w-[220px]"><EloRing /></div>
          </div>
          </section>

          {/* Matchmaking */}
          <section id="how-it-works" className="overflow-hidden min-h-[55vh] border-t border-[#9f84bd]/10">
          <div data-parallax="0.06" style={{ willChange: "transform" }} className="flex flex-row-reverse items-center gap-8 px-10 py-20">
            <div className="flex-1 min-w-0 pl-4">
              <h2 className="text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[0.9] tracking-[-0.03em] text-balance mb-6">
                matched<br />in seconds.
              </h2>
              <p className="text-white/50 text-base leading-relaxed max-w-[40ch] mb-6">
                skip the lobby. tap play, we find your opponent instantly. you&apos;re mid-prep, not mid-wait.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="text-[10px] font-mono text-[#118ab2] border border-[#118ab2]/25 bg-[#118ab2]/8 rounded-full px-3 py-1.5 tracking-wider">VARC ×1 speed</span>
                <span className="text-[10px] font-mono text-[#ffd166] border border-[#ffd166]/25 bg-[#ffd166]/8 rounded-full px-3 py-1.5 tracking-wider">DILR ×2 speed</span>
                <span className="text-[10px] font-mono text-[#06d6a0] border border-[#06d6a0]/25 bg-[#06d6a0]/8 rounded-full px-3 py-1.5 tracking-wider">QUANT ×2 speed</span>
              </div>
            </div>
            <div className="shrink-0 w-[230px] flex items-center justify-center"><MatchAnimation /></div>
          </div>
          </section>

          {/* Speed */}
          <section className="overflow-hidden min-h-[55vh] border-t border-[#9f84bd]/10">
          <div data-parallax="0.06" style={{ willChange: "transform" }} className="flex items-center gap-8 px-10 py-20">
            <div className="flex-1 min-w-0 pr-4">
              <h2 className="text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[0.9] tracking-[-0.03em] text-balance mb-6">
                fast fingers<br />bag more<br />points.
              </h2>
              <p className="text-white/50 text-base leading-relaxed max-w-[40ch] mb-4">
                right answer at 10 seconds beats right answer at 90. DILR and Quant reward speed twice as hard. big brain energy required.
              </p>
              <p className="text-white/30 text-sm leading-relaxed max-w-[40ch]">
                slow and correct is not the vibe. everyone gets the answer eventually. only the fast ones get rewarded.
              </p>
            </div>
            <div className="shrink-0 w-[200px] flex items-center justify-center"><SpeedTimer /></div>
          </div>
          </section>

          {/* Challenge */}
          <section id="challenge" className="overflow-hidden min-h-[55vh] border-t border-[#9f84bd]/10">
          <div data-parallax="0.06" style={{ willChange: "transform" }} className="flex flex-row-reverse items-center gap-8 px-10 py-20">
            <div className="flex-1 min-w-0 pl-4">
              <h2 className="text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[0.9] tracking-[-0.03em] text-balance mb-6">
                think you&apos;re<br />better?<br />prove it.
              </h2>
              <p className="text-white/50 text-base leading-relaxed max-w-[40ch]">
                send a link. they accept or they&apos;re cooked. rated or unrated, 15 min expiry. no excuses, no drama.
              </p>
            </div>
            <div className="shrink-0 w-[270px]"><ChallengeCard /></div>
          </div>
          </section>

          {/* Leaderboard */}
          <section className="overflow-hidden min-h-[55vh] border-t border-[#9f84bd]/10">
          <div data-parallax="0.06" style={{ willChange: "transform" }} className="flex items-center gap-8 px-10 py-20">
            <div className="flex-1 min-w-0 pr-4">
              <h2 className="text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[0.9] tracking-[-0.03em] text-balance mb-6">
                the board<br />doesn&apos;t cap.
              </h2>
              <p className="text-white/50 text-base leading-relaxed max-w-[40ch] mb-5">
                weekly resets keep it fresh. monthly tracks who actually put in the work. either way, your name&apos;s either on it or it&apos;s not.
              </p>
              {!IS_WAITLIST && (
                <Link href="/leaderboard" className="text-[#06d6a0] text-sm font-semibold hover:underline underline-offset-4">
                  see full leaderboard →
                </Link>
              )}
            </div>
            <div className="shrink-0 w-[270px]"><LeaderboardPreview /></div>
          </div>
          </section>

          <footer className="px-10 py-12 border-t border-[#9f84bd]/10">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-[#06d6a0] flex items-center justify-center overflow-hidden">
                  <NinjaLogo color="#120F17" className="w-5 h-5" />
                </div>
                <span className="font-semibold tracking-tight text-white">Ninjatest</span>
              </div>
              <div className="flex items-center gap-6">
                <a href="/privacy" className="text-white/35 hover:text-white/60 text-xs transition-colors">Privacy Policy</a>
                <a href="/terms" className="text-white/35 hover:text-white/60 text-xs transition-colors">Terms &amp; Conditions</a>
                {!IS_WAITLIST && (
                  <Link href="/leaderboard" className="text-white/35 hover:text-white/60 text-xs transition-colors">Leaderboard</Link>
                )}
              </div>
            </div>
            <p className="text-white/20 text-xs mt-6 font-mono">© 2026 Ninjatest. Built for the CAT grind.</p>
          </footer>
        </div>
      </div>

      {/* ── Right: green CTA panel ── */}
      <div
        className="shrink-0 bg-[#06d6a0] h-screen relative overflow-hidden"
        style={{
          width: isIdle ? "20vw" : "100vw",
          minWidth: "80px",
          transition: "width 500ms cubic-bezier(0.76, 0, 0.24, 1)",
        }}
      >
        {/* Collapsed trigger */}
        <button
          onClick={handleOpen}
          disabled={phase !== "idle"}
          className="absolute inset-0 flex flex-col items-center justify-center group w-full"
          style={{ opacity: isOpen ? 0 : 1, pointerEvents: phase === "idle" ? "auto" : "none", transition: "opacity 200ms ease-in-out" }}
        >
          <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors duration-200" />
          <div className="relative z-10 flex flex-col items-center gap-6">
            <svg viewBox="0 0 100 120" className="w-[clamp(32px,5vw,72px)] drop-shadow-lg group-hover:scale-110 transition-transform duration-200" aria-hidden>
              <polygon points="10,0 100,60 10,120" fill="#120F17" />
            </svg>
            <p className="text-[#120F17] font-black text-xs uppercase" style={{ writingMode: "vertical-rl", textOrientation: "mixed", transform: "rotate(180deg)", letterSpacing: "0.5em" }}>
              {IS_WAITLIST ? "WAITLIST" : "PLAY"}
            </p>
          </div>
          <p className="absolute bottom-6 text-[#120F17]/60 text-[10px] font-mono tracking-widest uppercase">
            {IS_WAITLIST ? "Join early" : "Sign in / up"}
          </p>
        </button>

        {/* Expanded panel content */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center px-6"
          style={{ opacity: isOpen ? 1 : 0, pointerEvents: isOpen ? "auto" : "none", transition: `opacity 300ms ease-in-out${isOpen ? " 350ms" : ""}` }}
        >
          <button onClick={handleBack} className="absolute top-6 left-6 text-[#120F17]/60 hover:text-[#120F17] text-sm font-medium transition-colors">
            ← Back
          </button>

          {IS_WAITLIST ? (
            /* ── Waitlist survey ── */
            <div className="w-full max-w-sm">
              {/* Logo header */}
              <div className="flex items-center justify-center gap-2 mb-8">
                <div className="w-9 h-9 rounded-full bg-[#120F17] flex items-center justify-center overflow-hidden shrink-0">
                  <NinjaLogo color="#06d6a0" className="w-6 h-6" />
                </div>
                <span className="text-[#120F17] font-black text-2xl tracking-tight">Ninjatest</span>
              </div>

              {surveyDone ? (
                <div className="text-center">
                  <div className="w-16 h-16 rounded-full bg-[#120F17] flex items-center justify-center mx-auto mb-5">
                    <span className="text-[#06d6a0] text-2xl">✓</span>
                  </div>
                  <h2 className="text-[#120F17] font-black text-2xl mb-2">You&apos;re in.</h2>
                  <p className="text-[#120F17]/60 text-sm leading-relaxed">We&apos;ll drop you a line when Ninjatest opens. Get ready to grind.</p>
                </div>
              ) : (
                <>
                  {/* Progress bar */}
                  <div className="flex gap-1 mb-8">
                    {QUESTIONS.map((_, i) => (
                      <div
                        key={i}
                        className="h-1 flex-1 rounded-full transition-all duration-300"
                        style={{ background: i <= step ? "#120F17" : "rgba(18,15,23,0.2)" }}
                      />
                    ))}
                  </div>

                  {step > 0 && (
                    <p className="text-[#120F17]/50 text-xs font-mono mb-2 uppercase tracking-widest">
                      {step} / {QUESTIONS.length - 1}
                    </p>
                  )}
                  <h2 className="text-[#120F17] font-black text-2xl mb-6 leading-tight">{q.label}</h2>

                  {/* Input */}
                  {(q.type === "text" || q.type === "email" || q.type === "tel") && (
                    <input
                      key={q.id}
                      type={q.type}
                      value={answers[q.id]}
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                      onKeyDown={handleKeyDown}
                      placeholder={"placeholder" in q ? q.placeholder : ""}
                      autoFocus
                      className="w-full h-12 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/35 text-base outline-none focus:border-[#120F17]/50 transition-all"
                    />
                  )}

                  {q.type === "select" && "options" in q && (
                    <div className="flex flex-col gap-2">
                      {q.options.map(opt => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setAnswers(a => ({ ...a, [q.id]: opt }))}
                          className={`w-full h-11 px-4 rounded-xl border text-sm font-semibold text-left transition-all ${
                            answers[q.id] === opt
                              ? "bg-[#120F17] text-[#06d6a0] border-[#120F17]"
                              : "bg-[#120F17]/8 text-[#120F17] border-[#120F17]/20 hover:border-[#120F17]/40"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}

                  {q.type === "pills" && "options" in q && (
                    <div className="flex gap-3 flex-wrap">
                      {q.options.map(opt => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setAnswers(a => ({ ...a, [q.id]: opt }))}
                          className={`px-5 py-3 rounded-xl border text-sm font-bold transition-all ${
                            answers[q.id] === opt
                              ? "bg-[#120F17] text-[#06d6a0] border-[#120F17]"
                              : "bg-[#120F17]/8 text-[#120F17] border-[#120F17]/20 hover:border-[#120F17]/40"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}

                  {surveyError && <p className="text-red-700 text-xs mt-2">{surveyError}</p>}

                  <button
                    onClick={step < QUESTIONS.length - 1 ? handleNext : handleSurveySubmit}
                    disabled={!currentValue().trim() || surveyLoading}
                    className="w-full h-11 mt-5 bg-[#120F17] text-[#06d6a0] font-bold text-sm rounded-full hover:bg-[#120F17]/80 transition-colors disabled:opacity-40"
                  >
                    {surveyLoading ? "…" : step < QUESTIONS.length - 1 ? "Next →" : "Submit →"}
                  </button>
                </>
              )}
            </div>
          ) : (
            /* ── Auth form ── */
            <div className="w-full max-w-sm">
              <div className="text-center mb-8">
                <div className="inline-flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#120F17] flex items-center justify-center overflow-hidden">
                    <NinjaLogo color="#06d6a0" className="w-5 h-5" />
                  </div>
                  <span className="text-[#120F17] font-bold text-xl tracking-tight">Ninjatest</span>
                </div>
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

              <form onSubmit={handleAuthSubmit} className="space-y-3">
                {authMode === "signup" && (
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                    placeholder="Username"
                    required minLength={3} maxLength={20}
                    className="w-full h-11 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/40 text-sm outline-none focus:border-[#120F17]/50 transition-all"
                  />
                )}
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" required
                  className="w-full h-11 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/40 text-sm outline-none focus:border-[#120F17]/50 transition-all"
                />
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password" required minLength={8}
                  className="w-full h-11 px-4 rounded-xl bg-[#120F17]/10 border border-[#120F17]/20 text-[#120F17] placeholder:text-[#120F17]/40 text-sm outline-none focus:border-[#120F17]/50 transition-all"
                />
                <button
                  type="submit" disabled={authLoading}
                  className="w-full h-11 bg-[#120F17] text-[#06d6a0] font-bold text-sm rounded-full hover:bg-[#120F17]/80 transition-colors disabled:opacity-50 mt-1"
                >
                  {authLoading ? "…" : authMode === "signin" ? "Enter the arena →" : "Create account →"}
                </button>
              </form>

              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-[#120F17]/20" />
                <span className="text-[#120F17]/50 text-xs">or</span>
                <div className="flex-1 h-px bg-[#120F17]/20" />
              </div>
              <GoogleSignInButton />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────── Sub-components (shared) ─────────── */

function EloRing() {
  const TARGET = 1247; const MAX = 2000;
  const [count, setCount] = useState(0);
  const [animated, setAnimated] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const observer = new IntersectionObserver(([e]) => { if (e.isIntersecting) setAnimated(true); }, { threshold: 0.3 });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!animated) return;
    const duration = 1600; const start = performance.now(); let id: number;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      setCount(Math.round((1 - Math.pow(1 - t, 3)) * TARGET));
      if (t < 1) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick); return () => cancelAnimationFrame(id);
  }, [animated]);
  const r = 68; const circ = 2 * Math.PI * r; const pct = animated ? TARGET / MAX : 0;
  return (
    <div ref={ref} className="flex flex-col items-center gap-4">
      <svg width="200" height="200" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r={r} fill="none" stroke="rgba(159,132,189,0.1)" strokeWidth="10" />
        <circle cx="100" cy="100" r={r} fill="none" stroke="#06d6a0" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} transform="rotate(-90 100 100)"
          style={{ transition: "stroke-dashoffset 1.6s cubic-bezier(0.16, 1, 0.3, 1)" }} />
        <text x="100" y="95" textAnchor="middle" fill="white" fontSize="32" fontWeight="900" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>{count}</text>
        <text x="100" y="115" textAnchor="middle" fill="rgba(159,132,189,0.55)" fontSize="10" style={{ fontFamily: "var(--font-geist-mono, monospace)", letterSpacing: "0.2em" }}>ELO</text>
      </svg>
      <div className="flex items-center gap-3"><span className="text-[#06d6a0] font-bold text-sm font-mono">+24</span><span className="text-white/25 text-xs">from last match</span></div>
      <div className="flex gap-3 text-[10px] font-mono text-white/20"><span>peak: 1289</span><span>·</span><span>W/L: 34/18</span></div>
    </div>
  );
}

function MatchAnimation() {
  const [found, setFound] = useState(false);
  useEffect(() => { const i = setInterval(() => setFound(f => !f), 2600); return () => clearInterval(i); }, []);
  return (
    <div className="flex flex-col items-center gap-5 p-4 w-full">
      <div className="h-6 flex items-center justify-center">
        {found
          ? <span className="bg-[#06d6a0] text-[#120F17] text-[9px] font-black tracking-[0.2em] uppercase px-3 py-1 rounded-full">match found</span>
          : <span className="text-[#9f84bd]/40 text-[9px] font-mono tracking-[0.2em] uppercase">searching...</span>}
      </div>
      <div className="flex items-center gap-5 justify-center w-full">
        <div className="flex flex-col items-center gap-2">
          <div className={`w-14 h-14 rounded-full border-2 flex items-center justify-center text-2xl transition-all duration-500 ${found ? "border-[#06d6a0] bg-[#06d6a0]/10 shadow-[0_0_18px_rgba(6,214,160,0.2)]" : "border-[#9f84bd]/25 bg-[#9f84bd]/5"}`}>🥷</div>
          <span className="text-white/35 text-[9px] font-mono uppercase tracking-wider">you</span>
        </div>
        <div className="flex flex-col gap-2 items-center">
          {found ? <span className="text-white/50 text-xs font-black font-mono">VS</span>
            : [0,1,2].map(i => <div key={i} className="w-1 h-1 rounded-full bg-[#9f84bd]/30 pulse-dot" style={{ animationDelay: `${i * 0.22}s` }} />)}
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className={`w-14 h-14 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${found ? "border-[#06d6a0] bg-[#06d6a0]/10 shadow-[0_0_18px_rgba(6,214,160,0.2)] text-2xl" : "border-dashed border-[#9f84bd]/15"}`}>
            {found ? "👾" : <span className="text-[#9f84bd]/20 text-[10px] font-mono">???</span>}
          </div>
          <span className="text-white/35 text-[9px] font-mono uppercase tracking-wider">{found ? "opponent" : "waiting"}</span>
        </div>
      </div>
      {found && <div className="flex items-center gap-3 text-[10px] font-mono text-white/30"><span>1247 ELO</span><span className="text-[#06d6a0]">≈</span><span>1231 ELO</span></div>}
    </div>
  );
}

function SpeedTimer() {
  const [secs, setSecs] = useState(90); const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const observer = new IntersectionObserver(([e]) => { if (e.isIntersecting) setActive(true); }, { threshold: 0.3 });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!active) return; const i = setInterval(() => setSecs(s => s <= 0 ? 90 : s - 1), 110); return () => clearInterval(i); }, [active]);
  const pct = secs / 90; const r = 52; const circ = 2 * Math.PI * r;
  const strokeColor = pct > 0.45 ? "#06d6a0" : pct > 0.2 ? "#ffd166" : "#ef476f";
  return (
    <div ref={ref} className="flex flex-col items-center gap-5">
      <div className="relative">
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(159,132,189,0.08)" strokeWidth="8" />
          <circle cx="70" cy="70" r={r} fill="none" stroke={strokeColor} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} transform="rotate(-90 70 70)"
            style={{ transition: "stroke-dashoffset 0.11s linear, stroke 0.3s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-white font-black text-xl leading-none" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>{secs}s</span>
          <span className="text-[#9f84bd]/35 text-[9px] font-mono uppercase tracking-wider mt-1">left</span>
        </div>
      </div>
      <div className="text-center">
        <p className="font-black text-2xl transition-colors leading-none" style={{ color: strokeColor, fontFamily: "var(--font-geist-mono, monospace)" }}>+{Math.round(100 * pct)} pts</p>
        <p className="text-white/20 text-[10px] mt-1.5 font-mono">answer now for max</p>
      </div>
    </div>
  );
}

function ChallengeCard() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-[#120F17]/55 border border-[#9f84bd]/15 rounded-2xl p-5 backdrop-blur-sm">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-[#9f84bd]/12 flex items-center justify-center text-lg shrink-0">🥷</div>
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold">arcxx1995</p>
          <p className="text-[#9f84bd]/45 text-xs">challenges you to a rated match</p>
        </div>
      </div>
      <div className="flex items-center gap-2 bg-[#120F17]/80 rounded-lg p-3 mb-4 border border-[#9f84bd]/8">
        <span className="text-[#9f84bd]/35 text-[10px] flex-1 truncate font-mono">ninjatest.app/c/abc123</span>
        <button onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className={`text-[10px] font-bold px-2.5 py-1 rounded-md transition-all shrink-0 ${copied ? "bg-[#06d6a0] text-[#120F17]" : "bg-[#9f84bd]/12 text-[#9f84bd]/70"}`}>
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] font-mono text-[#9f84bd]/35 bg-[#9f84bd]/5 border border-[#9f84bd]/8 rounded-lg p-3 mb-4">
        <span>9 questions</span><span>3 sections</span>
        <span className="text-[#ef476f]/60">⚔ rated</span><span>expires 14:32</span>
      </div>
      <button className="w-full bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-xl py-2.5 hover:bg-[#06d6a0]/90 transition-colors">accept the challenge →</button>
    </div>
  );
}

function LeaderboardPreview() {
  const [tab, setTab] = useState<"weekly" | "monthly">("weekly");
  const data = {
    weekly: [
      { rank: 1, name: "rizz_master99", elo: 2341, delta: +87 },
      { rank: 2, name: "catslayer", elo: 2289, delta: +64 },
      { rank: 3, name: "quantqueen", elo: 2201, delta: +43 },
      { rank: 4, name: "dilr_demon", elo: 2156, delta: -12 },
      { rank: 5, name: "arcxx1995", elo: 2089, delta: +29 },
    ],
    monthly: [
      { rank: 1, name: "catslayer", elo: 2489, delta: +312 },
      { rank: 2, name: "rizz_master99", elo: 2441, delta: +287 },
      { rank: 3, name: "varc_villain", elo: 2378, delta: +201 },
      { rank: 4, name: "quantqueen", elo: 2301, delta: +143 },
      { rank: 5, name: "arcxx1995", elo: 2189, delta: +129 },
    ],
  };
  const medals = ["🥇", "🥈", "🥉"];
  return (
    <div className="bg-[#120F17]/55 border border-[#9f84bd]/15 rounded-2xl overflow-hidden backdrop-blur-sm">
      <div className="flex">
        {(["weekly", "monthly"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-3 text-[9px] font-black tracking-[0.18em] uppercase transition-colors border-b ${tab === t ? "text-[#06d6a0] border-[#06d6a0]/50" : "text-[#9f84bd]/30 border-[#9f84bd]/8 hover:text-[#9f84bd]/55"}`}>
            {t === "weekly" ? "this week" : "this month"}
          </button>
        ))}
      </div>
      <div className="divide-y divide-[#9f84bd]/5">
        {data[tab].map(row => (
          <div key={row.rank} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-5 text-center shrink-0 text-base">
              {row.rank <= 3 ? medals[row.rank - 1] : <span className="text-[#9f84bd]/30 text-[10px] font-mono">#{row.rank}</span>}
            </span>
            <span className={`text-sm flex-1 truncate ${row.name === "arcxx1995" ? "text-[#06d6a0] font-bold" : "text-white/75"}`}>{row.name}</span>
            <span className="text-[#ffd166] font-black text-sm font-mono shrink-0">{row.elo}</span>
            <span className={`text-[10px] font-bold font-mono w-9 text-right shrink-0 ${row.delta >= 0 ? "text-[#06d6a0]" : "text-[#ef476f]"}`}>{row.delta >= 0 ? "+" : ""}{row.delta}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogoMarquee() {
  const items = ["VARC", "DILR", "QUANT", "ELO RATED", "REALTIME 1v1", "SPEED SCORING", "FRIEND CHALLENGES", "SERVER AUTHORITATIVE", "NEXT.JS", "SUPABASE", "TAILWIND CSS", "TYPESCRIPT"];
  return (
    <div className="overflow-hidden border-y border-[#9f84bd]/8 py-5 my-2">
      <div className="flex animate-marquee" style={{ width: "max-content" }}>
        {[...items, ...items].map((item, i) => (
          <span key={i} className="shrink-0 px-6 text-[#9f84bd]/22 text-[10px] font-mono tracking-[0.3em] uppercase">
            {item}<span className="ml-5 text-[#9f84bd]/12">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}
