"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { NinjaLogo } from "@/components/ninja-logo";
import { GoogleSignInButton } from "@/components/google-signin-button";
import { ThermalBoundary } from "@/components/landing/thermal-boundary";
import { ParticleFlow } from "@/components/landing/particle-flow";
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
          <nav className="px-10 pt-8 flex items-center justify-between sticky top-0 bg-[#120F17]/60 backdrop-blur-sm z-20 py-5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[#06d6a0] flex items-center justify-center shrink-0 overflow-hidden">
                <NinjaLogo color="#120F17" className="w-5 h-5" />
              </div>
              <span className="font-semibold tracking-tight">Ninjatest</span>
            </div>
            <div className="flex items-center gap-7">
              <a href="#ai" className="text-white/45 hover:text-white text-sm transition-colors">Ninja AI</a>
              <a href="#matchmaking" className="text-white/45 hover:text-white text-sm transition-colors">Matchmaking</a>
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

          {/* ── S1: Hero ── */}
          <section className="relative overflow-hidden">
            <div data-parallax="0.07" style={{ willChange: "transform" }} className="px-10 pt-14 pb-10">
              <div className="inline-flex items-center gap-2.5 bg-[#06d6a0]/8 border border-[#06d6a0]/20 rounded-full pl-2 pr-4 py-1.5 mb-8">
                <span className="w-5 h-5 rounded-full bg-[#06d6a0] flex items-center justify-center overflow-hidden animate-spin-slow">
                  <NinjaLogo color="#120F17" className="w-3.5 h-3.5" />
                </span>
                <span className="text-[#06d6a0] text-xs font-medium tracking-wide">Now rating aspirants across India</span>
              </div>
              <h1 className="font-pixel text-[clamp(2.9rem,5.8vw,5.2rem)] leading-[0.98] text-balance">
                <FlipWord /> prep is a solo sport.<br />
                <span className="text-[#06d6a0]">Not anymore.</span>
              </h1>
              <p className="mt-8 text-[#c5e8f0]/70 text-lg font-light max-w-[46ch] leading-relaxed">
                Nine questions. Three sections. One opponent. Real-time 1v1 mock battles,
                with a rating that tells you the truth about where you stand.
              </p>
              <div className="mt-10 flex items-center gap-5 flex-wrap">
                <button
                  onClick={handleOpen}
                  className="spring-pulse inline-flex items-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-6 py-3 hover:bg-[#05b088] transition-colors"
                >
                  {IS_WAITLIST ? "Join the waitlist →" : "Enter the arena →"}
                </button>
                <span className="text-[#7ab5cc]/50 text-xs font-mono">
                  9 questions · VARC / DILR / QUANT · ELO rated · under 10 minutes
                </span>
              </div>
            </div>
            <ThermalBoundary flipped height={190} />
          </section>

          {/* ── S2: Marquee ── */}
          <LogoMarquee />

          {/* ── S3: Match carousel ── */}
          <section className="overflow-hidden border-t border-[#222222] py-20">
            <div className="px-10 flex items-end justify-between gap-6 mb-10">
              <Reveal>
                <h2 className="font-pixel text-[clamp(1.9rem,3.8vw,3.2rem)] leading-[1.05]">
                  <span className="text-white">One opponent.</span><br />
                  <span className="text-[#c5e8f0]/60">Nine questions.</span><br />
                  <span className="text-[#7ab5cc]/35">No hiding.</span>
                </h2>
                <p className="mt-5 text-[#c5e8f0]/60 text-sm leading-relaxed max-w-[52ch]">
                  Every battle is a compressed mock: three VARC, three DILR, three Quant —
                  or nine from the section you fear most.
                </p>
              </Reveal>
              <CarouselControls />
            </div>
            <MatchCarousel />
          </section>

          {/* ── S4: AI section ── */}
          <section id="ai" className="overflow-hidden border-t border-[#222222] px-10 py-20 scroll-mt-24">
            <Reveal>
              <p className="text-[#06d6a0] text-xs font-mono uppercase tracking-[0.25em] mb-4 flex items-center gap-2">
                <Sparkles size={12} /> Ninja — the AI layer
              </p>
              <h2 className="font-pixel text-[clamp(1.9rem,3.8vw,3.2rem)] leading-[1.05] mb-5">
                After the battle,<br />the debrief.
              </h2>
              <p className="text-[#c5e8f0]/60 text-base leading-relaxed max-w-[52ch] mb-14">
                Ninja reviews your match the way a good teacher would: where you lost time,
                which trap you took, what to drill next. Then it builds the practice set itself.
              </p>
            </Reveal>

            <div className="space-y-16">
              <AiFeatureBlock
                eyebrow="Match debrief" accent="#06d6a0"
                title="Every swing moment, explained."
                body="A per-question breakdown of your time against your opponent's — including the two questions that actually decided the match."
                flip={false}
              ><DebriefMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="Ask Ninja" accent="#118ab2"
                title="Explanations on demand."
                body="Question-level reasoning whenever you want it — locked during live matches, open the second you finish."
                flip
              ><AskNinjaMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="Generated practice" accent="#ffd166"
                title="Drills built from your own mistakes."
                body="Weakness-targeted sets composed from your match history. If arrangements keep costing you, arrangements are what you get."
                flip={false}
              ><PracticeMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="A worthy bot" accent="#9f84bd"
                title="No opponent online? Still a match."
                body="The bot plays at your rating, honestly — it answers on its own clock and never peeks at the answer key."
                flip
              ><BotMock /></AiFeatureBlock>
            </div>
          </section>

          {/* ── S5: Matchmaking section ── */}
          <section id="matchmaking" className="overflow-hidden border-t border-[#222222] px-10 py-20 scroll-mt-24">
            <Reveal>
              <h2 className="font-pixel text-[clamp(1.9rem,3.8vw,3.2rem)] leading-[1.05] mb-5">
                Matched by the math,<br />in seconds.
              </h2>
              <p className="text-[#c5e8f0]/60 text-base leading-relaxed max-w-[52ch] mb-10">
                Tap play. The queue pairs you with someone at your level — the band widens
                the longer you wait, so you always get a game.
              </p>
            </Reveal>

            <MatchmakingViz />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
              <StatCard label="Time to match" highlight="under 10s" value="typical at peak" footnote="band widens 20 ELO per second" />
              <StatCard label="Rated fairness" highlight="zero-sum" value="every point won is a point lost" footnote="100 ELO floor, no farming" />
              <StatCard label="Rematch guard" highlight="3 per day" value="same rated pair" footnote="so ratings stay honest" />
            </div>

            <div className="flex flex-wrap gap-2 mt-8">
              {["ELO-banded queue", "heartbeat liveness", "forfeit protection", "friend challenges", "section-only battles", "seasonal soft resets"].map(f => (
                <span key={f} className="font-pixel text-[11px] text-[#7ab5cc] border border-[#7ab5cc]/20 bg-[#7ab5cc]/5 rounded-full px-3.5 py-1.5">
                  {f}
                </span>
              ))}
            </div>
          </section>

          {/* ── S6: Floating-pill parallax ── */}
          <PillParallax scrollParent={scrollRef} />

          {/* ── S7: Queue. Battle. Rank. ── */}
          <section className="overflow-hidden border-t border-[#222222] px-10 py-20">
            <Reveal>
              <h2 className="font-pixel text-[clamp(1.9rem,3.8vw,3.2rem)] leading-[1.05] mb-10">
                Queue. Battle. Rank.
              </h2>
            </Reveal>
            <ParticleFlow height={280} />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
              {[
                { n: "01", t: "Queue", b: "One tap. The server finds your equal." },
                { n: "02", t: "Battle", b: "Nine synchronized questions. Same clock, same order, no pauses." },
                { n: "03", t: "Rank", b: "Margin-weighted, zero-sum ELO. Beat a stronger player, gain more." },
              ].map((s, i) => (
                <Reveal key={s.n} delay={i * 100}>
                  <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 h-full">
                    <p className="text-[#06d6a0] text-[10px] font-mono mb-3">{s.n}</p>
                    <h3 className="font-pixel text-lg text-white mb-2">{s.t}</h3>
                    <p className="text-[#7ab5cc] text-sm leading-relaxed">{s.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ── S8: Closing CTA + footer ── */}
          <section className="relative overflow-hidden border-t border-[#222222]">
            <div className="px-10 pt-20 pb-8 text-center">
              <Reveal>
                <h2 className="font-pixel text-[clamp(2.2rem,4.5vw,4rem)] leading-[1.02] text-balance mb-6">
                  Your percentile<br />has an opponent.
                </h2>
                <p className="text-[#c5e8f0]/60 text-base leading-relaxed max-w-[46ch] mx-auto mb-8">
                  Join the waitlist — early aspirants get founding badges and first access
                  to rated seasons.
                </p>
                <button
                  onClick={handleOpen}
                  className="inline-flex items-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-7 py-3 hover:bg-[#05b088] transition-colors"
                >
                  {IS_WAITLIST ? "Join the waitlist →" : "Enter the arena →"}
                </button>
              </Reveal>
            </div>
            <ThermalBoundary height={170} />
          </section>

          <footer className="px-10 py-12 border-t border-[#222222]">
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
            <p className="text-white/20 text-xs mt-6 font-mono">© 2026 Ninjatest. Built for serious aspirants.</p>
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
                  <p className="text-[#120F17]/60 text-sm leading-relaxed">We&apos;ll write to you the moment Ninjatest opens. Keep the mocks coming.</p>
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

/* ─────────── Sub-components ─────────── */

/* Scroll entrance reveal (one-shot) */
function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); io.disconnect(); } }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${inView ? "is-in" : ""} ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

/* ── S3: infinite scroll-snap carousel ── */
const MATCH_CARDS = [
  { tag: "VARC", accent: "#118ab2", title: "Reading, against the clock", body: "Passage-grouped questions with a 60-second reading window before the timer starts charging.", metaLabel: "Timed at", metaValue: "90s per question" },
  { tag: "DILR", accent: "#ffd166", title: "Sets that fight back", body: "Puzzle sets served as a group — the hardest section gets the longest clock.", metaLabel: "Timed at", metaValue: "120s per question" },
  { tag: "QUANT", accent: "#06d6a0", title: "Speed is a skill", body: "The highest speed multiplier of the three. A fast correct answer out-scores a slow one.", metaLabel: "Timed at", metaValue: "105s per question" },
  { tag: "Scoring", accent: "#9f84bd", title: "The referee is a database", body: "Every answer is scored server-side. Client clocks and client claims are ignored.", metaLabel: "Measured", metaValue: "server time only" },
  { tag: "Speed bonus", accent: "#06d6a0", title: "Every 5 seconds saved counts", body: "Bonus accrues in five-second blocks. A random guess is worth exactly zero expected points.", metaLabel: "Max", metaValue: "140 pts / question" },
  { tag: "Live", accent: "#118ab2", title: "You see them answer", body: "Real-time presence: you know the moment your opponent locks in — never what they chose.", metaLabel: "Latency", metaValue: "under a second" },
  { tag: "Spectate", accent: "#ffd166", title: "Watch the top table", body: "Any live match is watchable, read-only, with answers hidden until the reveal.", metaLabel: "Delay", metaValue: "none" },
];

// Module-level ref so header controls (rendered in a different subtree) can
// drive the viewport without lifting state into the page component.
let carouselViewport: HTMLDivElement | null = null;
const CARD_W = 300, CARD_GAP = 16;

function CarouselControls() {
  const nudge = (dir: 1 | -1) => carouselViewport?.scrollBy({ left: dir * (CARD_W + CARD_GAP), behavior: "smooth" });
  const btn = "w-10 h-10 rounded-full border border-[#333333] text-[#7ab5cc] hover:border-[#06d6a0]/50 hover:text-[#06d6a0] transition-colors flex items-center justify-center";
  return (
    <div className="hidden md:flex gap-2 shrink-0">
      <button aria-label="Previous cards" className={btn} onClick={() => nudge(-1)}>←</button>
      <button aria-label="Next cards" className={btn} onClick={() => nudge(1)}>→</button>
    </div>
  );
}

function MatchCarousel() {
  const ref = useRef<HTMLDivElement>(null);
  const setW = MATCH_CARDS.length * (CARD_W + CARD_GAP);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    carouselViewport = el;
    el.scrollLeft = setW; // start on the middle copy
    const onScroll = () => {
      // teleport across clone boundaries to fake an infinite track
      if (el.scrollLeft < setW * 0.25) el.scrollLeft += setW;
      else if (el.scrollLeft > setW * 1.9) el.scrollLeft -= setW;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (carouselViewport === el) carouselViewport = null; };
  }, [setW]);

  return (
    <div
      ref={ref}
      tabIndex={0}
      aria-label="What a match looks like"
      className="overflow-x-auto no-scrollbar snap-x snap-mandatory px-10"
      style={{ scrollPaddingInline: 40 }}
    >
      <div className="flex" style={{ width: "max-content", gap: CARD_GAP }}>
        {[...MATCH_CARDS, ...MATCH_CARDS, ...MATCH_CARDS].map((c, i) => (
          <article
            key={i}
            className="snap-start shrink-0 bg-[#111111] border border-[#222222] rounded-xl p-5 flex flex-col"
            style={{ width: CARD_W, minHeight: 220 }}
          >
            <p className="font-pixel text-[11px] mb-4" style={{ color: c.accent }}>{c.tag}</p>
            <h3 className="font-pixel text-lg text-white leading-snug mb-2">{c.title}</h3>
            <p className="text-[#7ab5cc] text-sm leading-relaxed flex-1">{c.body}</p>
            <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#222222]">
              <span className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-wider">{c.metaLabel}</span>
              <span className="text-[11px] font-mono font-bold" style={{ color: c.accent }}>{c.metaValue}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ── S4: AI feature blocks + product mocks ── */
function AiFeatureBlock({ eyebrow, accent, title, body, flip, children }: {
  eyebrow: string; accent: string; title: string; body: string; flip: boolean; children: React.ReactNode;
}) {
  return (
    <div className={`flex items-center gap-10 flex-wrap md:flex-nowrap ${flip ? "md:flex-row-reverse" : ""}`}>
      <Reveal className="flex-1 min-w-[260px]">
        <span className="inline-block font-pixel text-[11px] rounded-full border px-3 py-1 mb-4"
          style={{ color: accent, borderColor: `${accent}40`, background: `${accent}14` }}>
          {eyebrow}
        </span>
        <h3 className="font-pixel text-2xl text-white leading-snug mb-3">{title}</h3>
        <p className="text-[#7ab5cc] text-sm leading-relaxed max-w-[46ch]">{body}</p>
      </Reveal>
      <div className="flex-1 min-w-[280px] relative">
        <div data-parallax="0.1" className="absolute inset-4 rounded-2xl blur-2xl opacity-20" style={{ background: accent, willChange: "transform" }} />
        <div data-parallax="0.06" style={{ willChange: "transform" }} className="relative">{children}</div>
      </div>
    </div>
  );
}

function DebriefMock() {
  return (
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-5">
      <h4 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Sparkles size={12} className="text-[#06d6a0]" /> Ninja debrief
      </h4>
      <p className="text-[#c5e8f0] text-sm leading-relaxed mb-4">
        You won the match in DILR: 41 seconds faster across the set, both correct.
        Q4 is where it turned — your opponent spent 68s on the seating arrangement
        and guessed; you skipped in 12s and banked the clock.
      </p>
      <div className="flex flex-wrap gap-2">
        <span className="text-[10px] font-mono text-[#06d6a0] bg-[#06d6a0]/10 border border-[#06d6a0]/20 rounded-full px-2.5 py-1">Q4 · +41s banked</span>
        <span className="text-[10px] font-mono text-[#ef476f] bg-[#ef476f]/10 border border-[#ef476f]/20 rounded-full px-2.5 py-1">Q7 · trap option C</span>
        <span className="text-[10px] font-mono text-[#ffd166] bg-[#ffd166]/10 border border-[#ffd166]/20 rounded-full px-2.5 py-1">VARC pace · −9s avg</span>
      </div>
    </div>
  );
}

function AskNinjaMock() {
  return (
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 space-y-3">
      <div className="flex justify-end">
        <p className="bg-[#1c1c1c] text-[#c5e8f0] text-sm rounded-lg rounded-br-sm px-3.5 py-2.5 max-w-[85%]">
          Why is option B wrong here? The passage seems to support it.
        </p>
      </div>
      <div className="flex gap-2.5">
        <span className="w-6 h-6 rounded-full bg-[#06d6a0] flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
          <NinjaLogo color="#120F17" className="w-4 h-4" />
        </span>
        <p className="text-[#c5e8f0] text-sm leading-relaxed">
          B restates the author&apos;s example, not the argument. The passage uses the
          2010 census as an illustration — the claim itself is in the final
          paragraph, which only D paraphrases without adding &quot;always&quot;.
        </p>
      </div>
    </div>
  );
}

function PracticeMock() {
  const rows = [
    { s: "DILR", c: "#ffd166", t: "Circular arrangement · 6 people, 2 constraints", d: "targets Q4-type skips" },
    { s: "DILR", c: "#ffd166", t: "Linear arrangement · conditional clues", d: "targets slow starts" },
    { s: "VARC", c: "#118ab2", t: "Inference · author's main claim", d: "targets trap option C" },
  ];
  return (
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-5">
      <h4 className="text-[#7ab5cc] text-xs font-medium uppercase tracking-wider mb-4 flex items-center gap-1.5">
        <Sparkles size={12} className="text-[#ffd166]" /> Generated practice · from your last 5 matches
      </h4>
      <div className="space-y-2.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-3 bg-[#1c1c1c] rounded-lg px-3.5 py-2.5">
            <span className="text-[10px] font-mono font-bold shrink-0" style={{ color: r.c }}>{r.s}</span>
            <span className="text-[#c5e8f0] text-xs flex-1 truncate">{r.t}</span>
            <span className="text-[#4a8fa8] text-[10px] font-mono shrink-0 hidden sm:block">{r.d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BotMock() {
  return (
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-[#9f84bd]/15 border border-[#9f84bd]/30 flex items-center justify-center overflow-hidden">
            <NinjaLogo color="#9f84bd" className="w-5 h-5" />
          </span>
          <div>
            <p className="text-white text-sm font-semibold leading-none">NINJA-BOT</p>
            <p className="text-[#4a8fa8] text-[10px] font-mono mt-1">plays at 1240 ELO · unrated</p>
          </div>
        </div>
        <span className="text-[10px] font-mono text-[#7ab5cc] bg-[#7ab5cc]/10 border border-[#7ab5cc]/20 rounded-full px-2.5 py-1">Q 5 / 9</span>
      </div>
      <div className="flex items-center gap-4 bg-[#1c1c1c] rounded-lg px-4 py-3">
        <span className="w-2 h-2 rounded-full bg-[#06d6a0] animate-pulse shrink-0" />
        <p className="text-[#c5e8f0] text-xs flex-1">Bot is reading the question…</p>
        <span className="font-pixel text-sm text-[#ffd166]">0:47</span>
      </div>
    </div>
  );
}

/* ── S5: matchmaking visualization ── */
function MatchmakingViz() {
  const [view, setView] = useState<"wait" | "gap">("wait");

  // Band-vs-wait: band = min(1000, 100 + 20s), 0–60s → x 0..520, y 240..20
  const bandPts = Array.from({ length: 61 }, (_, s) => {
    const band = Math.min(1000, 100 + 20 * s);
    return `${20 + (s / 60) * 500},${240 - (band / 1000) * 200}`;
  }).join(" ");

  // ELO-exchanged-vs-gap: Δ ≈ K(1−E)·shrink for the favorite, K=24
  const gapPts = Array.from({ length: 41 }, (_, i) => {
    const gap = i * 20; // 0..800
    const e = 1 / (1 + Math.pow(10, -gap / 400));
    const shrink = 2.2 / (0.001 * gap + 2.2);
    const delta = 24 * (1 - e) * shrink;
    return `${20 + (gap / 800) * 500},${240 - (delta / 12) * 200}`;
  }).join(" ");

  const pill = (v: "wait" | "gap", label: string) => (
    <button
      onClick={() => setView(v)}
      className={`font-pixel text-[11px] rounded-full px-4 py-2 border transition-colors ${
        view === v
          ? "bg-[#06d6a0] text-[#120F17] border-[#06d6a0]"
          : "text-[#7ab5cc] border-[#333333] hover:border-[#06d6a0]/50 hover:text-[#06d6a0]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Reveal>
      <div className="flex gap-2 mb-5">
        {pill("wait", "By wait time")}
        {pill("gap", "By rating gap")}
      </div>
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 overflow-x-auto">
        <svg viewBox="0 0 560 270" className="w-full min-w-[480px]" role="img"
          aria-label={view === "wait" ? "Matchmaking band width versus seconds waited" : "ELO exchanged versus rating gap"}>
          {/* grid */}
          {[20, 130, 240].map(y => <line key={y} x1="20" y1={y} x2="520" y2={y} stroke="#222222" strokeWidth="1" />)}

          {view === "wait" ? (
            <g>
              <polyline points={bandPts} fill="none" stroke="#06d6a0" strokeWidth="2.5" />
              <polygon points={`20,240 ${bandPts} 520,240`} fill="#06d6a0" opacity="0.07" />
              <circle cx="20" cy={240 - (100 / 1000) * 200} r="5" fill="#06d6a0" />
              <text x="32" y={240 - (100 / 1000) * 200 - 8} fill="#c5e8f0" fontSize="11" fontFamily="var(--font-geist-mono)">you join · ±100 ELO</text>
              <circle cx={20 + (45 / 60) * 500} cy={240 - (1000 / 1000) * 200} r="5" fill="#ffd166" />
              <text x={20 + (45 / 60) * 500 - 150} y={240 - 200 + 16} fill="#ffd166" fontSize="11" fontFamily="var(--font-geist-mono)">45s · band fully open ±1000</text>
              <text x="20" y="262" fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">0s</text>
              <text x="500" y="262" fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">60s waited</text>
            </g>
          ) : (
            <g>
              <polyline points={gapPts} fill="none" stroke="#06d6a0" strokeWidth="2.5" />
              <circle cx="20" cy={240 - (12 / 12) * 200} r="5" fill="#06d6a0" />
              <text x="32" y={240 - 200 + 4} fill="#c5e8f0" fontSize="11" fontFamily="var(--font-geist-mono)">even match · full stakes</text>
              <circle cx={20 + (400 / 800) * 500} cy={240 - ((24 * (1 - 1 / (1 + Math.pow(10, -1))) * (2.2 / (0.4 + 2.2))) / 12) * 200} r="5" fill="#ffd166" />
              <text x={20 + (400 / 800) * 500 + 12} y={240 - ((24 * (1 - 1 / (1 + Math.pow(10, -1))) * (2.2 / (0.4 + 2.2))) / 12) * 200 + 4} fill="#ffd166" fontSize="11" fontFamily="var(--font-geist-mono)">favorite beats +400 · little to gain</text>
              <text x="20" y="262" fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">gap 0</text>
              <text x="452" y="262" fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">gap 800</text>
            </g>
          )}
        </svg>
        <p className="text-[#4a8fa8] text-[10px] font-mono mt-2">
          {view === "wait"
            ? "Derived from the live queue rule: band = min(1000, 100 + 20 × seconds waited)."
            : "Derived from the live rating rule: favorites gain less, upsets pay more — zero-sum either way."}
        </p>
      </div>
    </Reveal>
  );
}

function StatCard({ label, highlight, value, footnote }: { label: string; highlight: string; value: string; footnote: string }) {
  return (
    <Reveal>
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 h-full">
        <p className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-wider mb-3">{label}</p>
        <p className="font-pixel text-3xl text-[#06d6a0] mb-1">{highlight}</p>
        <p className="text-[#c5e8f0] text-sm mb-3">{value}</p>
        <p className="text-[#4a8fa8] text-[10px] font-mono">{footnote}</p>
      </div>
    </Reveal>
  );
}

/* ── S6: floating-pill parallax scene ── */
const TRACK_PILLS: { label: string; color: string; left: string; top: string; speed: number }[] = [
  { label: "reading speed",           color: "#118ab2", left: "6%",  top: "58%",  speed: 0.72 },
  { label: "set selection",           color: "#ffd166", left: "30%", top: "66%",  speed: 0.68 },
  { label: "guess discipline",        color: "#06d6a0", left: "62%", top: "60%",  speed: 0.78 },
  { label: "time per question",       color: "#7ab5cc", left: "84%", top: "70%",  speed: 0.76 },
  { label: "accuracy under pressure", color: "#06d6a0", left: "14%", top: "88%",  speed: 0.83 },
  { label: "win streaks",             color: "#ffd166", left: "48%", top: "92%",  speed: 0.9 },
  { label: "peak rating",             color: "#ffd166", left: "76%", top: "96%",  speed: 0.7 },
  { label: "section splits",          color: "#118ab2", left: "8%",  top: "110%", speed: 0.74 },
  { label: "head-to-head history",    color: "#9f84bd", left: "38%", top: "116%", speed: 0.86 },
  { label: "league placement",        color: "#c5e8f0", left: "68%", top: "112%", speed: 0.69 },
  { label: "daily tasks",             color: "#06d6a0", left: "20%", top: "130%", speed: 0.8 },
  { label: "season rank",             color: "#ffd166", left: "56%", top: "134%", speed: 0.73 },
  { label: "speed bonus rate",        color: "#06d6a0", left: "82%", top: "128%", speed: 0.88 },
  { label: "comeback record",         color: "#ef476f", left: "12%", top: "148%", speed: 0.77 },
  { label: "first-60s decisions",     color: "#7ab5cc", left: "44%", top: "152%", speed: 0.92 },
];

function PillParallax({ scrollParent }: { scrollParent: React.RefObject<HTMLDivElement | null> }) {
  const sectionRef = useRef<HTMLElement>(null);
  const pillRefs = useRef<(HTMLDivElement | null)[]>([]);

  const update = useCallback(() => {
    const section = sectionRef.current;
    if (!section) return;
    const vh = window.innerHeight;
    const rect = section.getBoundingClientRect();
    const travel = rect.height - vh;
    const progress = Math.max(0, Math.min(1, -rect.top / travel));
    pillRefs.current.forEach((el, i) => {
      if (el) el.style.transform = `translateY(${-progress * travel * TRACK_PILLS[i].speed}px)`;
    });
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // settle mid-scene so the pills read as a static composition
      pillRefs.current.forEach((el, i) => {
        const section = sectionRef.current;
        if (el && section) el.style.transform = `translateY(${-0.5 * (section.getBoundingClientRect().height - window.innerHeight) * TRACK_PILLS[i].speed}px)`;
      });
      return;
    }
    const parent = scrollParent.current;
    if (!parent) return;
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    parent.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { parent.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [scrollParent, update]);

  return (
    <section ref={sectionRef} className="relative border-t border-[#222222]" style={{ height: "220vh" }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* center sentence */}
        <div className="absolute inset-0 flex items-center justify-center px-10 z-10">
          <h2 className="font-pixel text-[clamp(1.9rem,4vw,3.4rem)] leading-[1.05] text-center text-balance">
            One rating.<br />
            <span className="text-[#06d6a0]">Every habit it exposes.</span>
          </h2>
        </div>
        {/* drifting pills */}
        <div aria-hidden className="absolute inset-0">
          {TRACK_PILLS.map((p, i) => (
            <div
              key={p.label}
              ref={el => { pillRefs.current[i] = el; }}
              className="absolute flex items-center gap-2 rounded-full border px-3.5 py-1.5 whitespace-nowrap"
              style={{
                left: p.left, top: p.top,
                color: p.color, borderColor: `${p.color}33`, background: `${p.color}0f`,
                willChange: "transform",
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
              <span className="font-pixel text-[11px]">{p.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── S2: marquee ticker ── */
function LogoMarquee() {
  const items = [
    "CAT", "XAT", "GMAT", "SSC", "BANK", "JEE", "NEET",
    "2,400 ELO CEILING", "90S PER VARC QUESTION", "ZERO-SUM RATINGS",
    "SEASONS RESET MONTHLY", "SPECTATE LIVE MATCHES", "SERVER-SCORED",
  ];
  return (
    <div className="overflow-hidden border-y border-[#222222] py-5">
      <div className="flex animate-marquee hover:[animation-play-state:paused]" style={{ width: "max-content" }}>
        {[...items, ...items].map((item, i) => (
          <span key={i} className="shrink-0 px-6 font-pixel text-[10px] text-[#7ab5cc]/40 tracking-[0.3em] uppercase">
            {item}<span className="ml-5 text-[#06d6a0]/25">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}
