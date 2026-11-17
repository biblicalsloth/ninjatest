"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  BarChart3, Bot, Check, ChevronRight, Eye, Flame, Home, Lightbulb,
  LogOut, Settings, Sparkles, Target, Trophy, Users, Zap,
} from "lucide-react";
import { getSectionBadgeClass } from "@/lib/utils";
import { getLeague } from "@/lib/leagues";
import { CountdownRing } from "@/components/countdown-ring";
import { SpeedMeter } from "@/components/speed-meter";
import { NinjaLogo, NinjatestLogo } from "@/components/ninja-logo";
import { GoogleSignInButton } from "@/components/google-signin-button";
import { ParticleFlow } from "@/components/landing/particle-flow";
import BentoGrid from "@/components/kokonutui/bento-grid";
import dynamic from "next/dynamic";

const Grainient = dynamic(() => import("@/components/Grainient"), { ssr: false });

const IS_WAITLIST = process.env.NEXT_PUBLIC_APP_MODE === "waitlist";

/* ── Airport-board flip word ── */
const EXAMS = ["GMAT", "CAT", "GRE", "LSAT", "JEE", "UPSC", "NEET", "MCAT", "SAT", "UCAT", "ACT", "TSA"];
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
  // Hidden stack of every word sizes the box to the widest exam; the visible
  // word is absolutely positioned on top, so it's out of flow and can never
  // shift "Built for" / "prep battles" as it flips.
  return (
    <span style={{ position: "relative", display: "inline-grid", verticalAlign: "baseline" }}>
      {EXAMS.map(w => (
        <span key={w} aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden" }}>{w}</span>
      ))}
      <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <FlipTile key={idx} word={EXAMS[idx]} />
      </span>
    </span>
  );
}

/* ── Survey questions ── */
type Answer = { name: string; email: string; phone: string; year: string; percentile: string; section: string };
const QUESTIONS = [
  { id: "name" as const,       label: "What's your name?",           type: "text",   placeholder: "Your name" },
  { id: "email" as const,      label: "Email address?",              type: "email",  placeholder: "you@example.com" },
  { id: "phone" as const,      label: "Phone number?",               type: "tel",    placeholder: "+91 98765 43210" },
  { id: "year" as const,       label: "When do you sit the exam?",   type: "select", options: ["2025", "2026", "2027", "2028"] },
  { id: "percentile" as const, label: "Where are your mocks landing?", type: "select", options: ["Bottom half", "50–70", "70–85", "85–95", "Top 5%"] },
  { id: "section" as const,    label: "Which part hurts most?",      type: "pills",  options: ["Verbal", "Logic", "Quant"] },
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

  // /#waitlist opens the survey straight away — /pricing and /docs point their
  // CTAs here instead of /auth/signup while the app is closed. The panel is
  // state, not a route, so a hash is the whole handoff.
  useEffect(() => {
    if (window.location.hash === "#waitlist") handleOpen();
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
          width: isIdle ? "100vw" : "0vw",
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
          <nav className="px-10 pt-8 flex items-center justify-between sticky top-0 z-20 py-5">
            <NinjatestLogo />
            <div className="flex items-center gap-7">
              <a href="#ai" className="text-white/45 hover:text-white text-sm transition-colors">Ninja AI</a>
              <a href="#matchmaking" className="text-white/45 hover:text-white text-sm transition-colors">Matchmaking</a>
              <Link href="/pricing" className="text-white/45 hover:text-white text-sm transition-colors">Pricing</Link>
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
            <div data-parallax="0.07" style={{ willChange: "transform" }} className="relative z-10 px-10 pt-14 pb-10 flex flex-col items-center text-center">
              <h1 className="font-pixel text-[clamp(2.9rem,5.8vw,5.2rem)] leading-[0.98] text-balance">
                <span className="text-[#06d6a0]">Competitive Exams</span> prep is a solo sport.<br />
                <span className="text-[#06d6a0]">Not anymore.</span>
              </h1>
              <p className="mt-8 text-[#c5e8f0]/70 text-lg font-light max-w-[54ch] leading-relaxed mx-auto">
                Ninjatest turns studying into a live 1v1 game. Get matched with someone at
                your level, race them through a short set of questions, and walk away with a
                rating that tells you exactly where you stand.
              </p>
              <div className="mt-10 flex items-center justify-center gap-5 flex-wrap">
                <button
                  onClick={handleOpen}
                  className="spring-pulse inline-flex items-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-6 py-3 hover:bg-[#05b088] transition-colors"
                >
                  {IS_WAITLIST ? "Join Waitlist →" : "Enter the arena →"}
                </button>
              </div>
            </div>
          </section>

          {/* ── S2: Marquee ── */}
          <LogoMarquee />

          {/* ── S2·5: the real dashboard, straight under the marquee ── */}
          <DashboardShot />

          {/* ── S2a: Vetted by ── */}
          <InstituteMarquee />

          {/* ── S2b: Built for battle prep ── */}
          <section className="px-10 py-10 border-b border-[#222222] text-center">
            <p className="font-pixel text-[clamp(1.4rem,3vw,2.4rem)] leading-[1.05]">
              Built for <FlipWord /> prep battles
            </p>
            <p className="mt-4 text-[#c5e8f0]/50 text-sm font-mono uppercase tracking-[0.2em]">
              One arena for the world&apos;s toughest competitive exams
            </p>
          </section>

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
                  A match is a short mock with the boring parts cut out — a few from each
                  part of the paper, or all nine from the one you keep avoiding.
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
              <p className="text-[#c5e8f0]/60 text-base leading-relaxed max-w-[52ch] mb-12">
                The match ends and Ninja is already reading it back to you — where the time
                went, which answer was bait, what to fix tonight. The kind of read you would
                get from a friend who watched the whole thing.
              </p>
            </Reveal>

            <div className="grid gap-4 md:grid-cols-2">
              <AiFeatureBlock
                eyebrow="Your match, read back"
                accent="#06d6a0"
                title="The two questions that decided it"
                body="Not a wall of stats. A short read on where you pulled ahead, where you bled time, and the moment the match actually turned."
              ><DebriefMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="Ask about any question"
                accent="#118ab2"
                title="&ldquo;Why was that wrong?&rdquo;"
                body="Ask about anything you just answered and get a real explanation, not the textbook line. Locked while you are playing — nobody gets to phone a friend mid-match."
              ><AskNinjaMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="Drills that follow"
                accent="#ffd166"
                title="Homework you did not have to set"
                body="Whatever cost you the match becomes tonight's practice set. Keep losing to the same puzzle type and that is what keeps showing up."
              ><PracticeMock /></AiFeatureBlock>

              <AiFeatureBlock
                eyebrow="Nobody around"
                accent="#9f84bd"
                title="There is always a game"
                body="If nobody is online, the bot plays. It answers at your level, on its own clock, and it never peeks at the answer key."
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
                Tap play and we look for someone your speed. The longer nobody turns up,
                the wider we look — so you are never left standing there.
              </p>
            </Reveal>

            <MatchmakingViz />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
              <StatCard label="Waiting around" highlight="under 10s" value="usual wait in the evening" footnote="we widen the search every second" />
              <StatCard label="What a win is worth" highlight="their loss" value="you gain exactly what they drop" footnote="no points invented, none destroyed" />
              <StatCard label="Farming your friend" highlight="3 a day" value="same two people, rated" footnote="after that it is just for fun" />
            </div>

            <div className="flex flex-wrap gap-2 mt-8">
              {["matched to your level", "play a friend by code", "one-part-only matches", "watch live matches", "monthly seasons", "win streaks"].map(f => (
                <span key={f} className="font-pixel text-[11px] text-[#7ab5cc] border border-[#7ab5cc]/20 bg-[#7ab5cc]/5 rounded-full px-3.5 py-1.5">
                  {f}
                </span>
              ))}
            </div>
          </section>

          {/* ── S5b: Feature bento ── */}
          <section id="features" className="overflow-hidden border-t border-[#222222] px-10 py-20 scroll-mt-24">
            <Reveal>
              <h2 className="font-pixel text-[clamp(1.9rem,3.8vw,3.2rem)] leading-[1.05] mb-5">
                Built like a game.<br />Marked like the exam.
              </h2>
              <p className="text-[#c5e8f0]/60 text-base leading-relaxed max-w-[52ch] mb-10">
                Six things you get on day one. All of them are the point — none of them
                are a settings screen.
              </p>
            </Reveal>
            <BentoGrid />
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
                { n: "01", t: "Queue", b: "One tap. We go and find someone your speed." },
                { n: "02", t: "Battle", b: "Nine questions, your own clock, no pausing and no going back." },
                { n: "03", t: "Rank", b: "Win big and you climb faster. Beat someone better and you climb faster still." },
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
                  Get on the list. Early players keep a founding badge and get first go at
                  the ranked seasons.
                </p>
                <button
                  onClick={handleOpen}
                  className="inline-flex items-center gap-2 bg-[#06d6a0] text-[#120F17] font-bold text-sm rounded-full px-7 py-3 hover:bg-[#05b088] transition-colors"
                >
                  {IS_WAITLIST ? "Join the waitlist →" : "Enter the arena →"}
                </button>
              </Reveal>
            </div>
          </section>

          <footer className="px-10 py-12 border-t border-[#222222]">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <NinjatestLogo />
              <div className="flex items-center gap-6">
                <a href="/privacy" className="text-white/35 hover:text-white/60 text-xs transition-colors">Privacy Policy</a>
                <a href="/terms" className="text-white/35 hover:text-white/60 text-xs transition-colors">Terms &amp; Conditions</a>
                <Link href="/pricing" className="text-white/35 hover:text-white/60 text-xs transition-colors">Pricing</Link>
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
          width: isIdle ? "0vw" : "100vw",
          minWidth: isIdle ? "0px" : "80px",
          transition: "width 500ms cubic-bezier(0.76, 0, 0.24, 1)",
        }}
      >
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
              <div className="flex justify-center mb-8">
                <NinjatestLogo onMint />
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
                <NinjatestLogo onMint className="mb-2" />
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
  { tag: "Verbal", accent: "#118ab2", title: "Read fast, or read again", body: "Passages come with a free minute to read before the clock starts charging you. After that, every second is on the meter.", metaLabel: "You get", metaValue: "90s a question" },
  { tag: "Logic", accent: "#ffd166", title: "Puzzles that fight back", body: "Sets arrive whole, the way they do in the real paper. It is the hardest part, so it gets the longest clock.", metaLabel: "You get", metaValue: "120s a question" },
  { tag: "Quant", accent: "#06d6a0", title: "Being quick is worth points", body: "The biggest speed reward of the three. Two people can both be right and only one of them wins the question.", metaLabel: "You get", metaValue: "105s a question" },
  { tag: "Fair play", accent: "#9f84bd", title: "Nobody can fudge their time", body: "Your score is worked out on our side, not in your browser. A slow laptop cannot cost you points and a clever one cannot win them.", metaLabel: "Timed by", metaValue: "our clock" },
  { tag: "Speed bonus", accent: "#06d6a0", title: "Every five seconds saved counts", body: "Answer sooner and the question is worth more. Wild guessing is worth nothing on average — that is deliberate.", metaLabel: "Best case", metaValue: "140 pts a question" },
  { tag: "Live", accent: "#118ab2", title: "You feel them answering", body: "You see the moment your opponent locks something in. You never see what they picked.", metaLabel: "Delay", metaValue: "under a second" },
  { tag: "Spectate", accent: "#ffd166", title: "Watch the good ones play", body: "Any live match can be watched from the stands. Answers stay hidden until the players are done.", metaLabel: "Cost", metaValue: "free, always" },
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

/* ── S4: AI feature cards + product mocks ──
   Restyled 2026-07-26: was an alternating flip layout with a blurred colour
   glow parallaxing behind each mock. Now one card per feature — copy on top,
   the real screen underneath, hairline between. Same card language as the
   bento so the page reads as one system. */
function AiFeatureBlock({ eyebrow, accent, title, body, children }: {
  eyebrow: string; accent: string; title: string; body: string; children: React.ReactNode;
}) {
  return (
    <Reveal className="h-full">
      <div className="h-full flex flex-col rounded-2xl border border-[#222222] bg-[#111111] p-6 transition-colors duration-300 hover:border-[#06d6a0]/35">
        <span className="inline-flex self-start items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] rounded-full border px-2.5 py-1"
          style={{ color: accent, borderColor: `${accent}33`, background: `${accent}14` }}>
          <span className="w-1 h-1 rounded-full" style={{ background: accent }} />
          {eyebrow}
        </span>
        <h3 className="font-pixel text-xl text-white leading-snug mt-4">{title}</h3>
        <p className="text-[#7ab5cc] text-sm leading-relaxed mt-3">{body}</p>
        <div className="mt-6 pt-6 border-t border-[#222222]">{children}</div>
      </div>
    </Reveal>
  );
}

/* Mocks render inside a card now, so they drop their own border/background —
   a card inside a card is the boxy look this section was redone to remove. */
function MockHead({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <h4 className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-[0.18em] mb-3 flex items-center gap-1.5">
      {icon} {label}
    </h4>
  );
}

function DebriefMock() {
  return (
    <div>
      <MockHead icon={<Sparkles size={11} className="text-[#06d6a0]" />} label="Ninja debrief" />
      <p className="text-[#c5e8f0] text-sm leading-relaxed mb-4">
        You won this on the puzzle set — 41 seconds quicker, both of you right.
        Question 4 is where it turned: they burned 68 seconds and guessed anyway,
        you walked away after 12 and spent the time elsewhere.
      </p>
      <div className="flex flex-wrap gap-2">
        <span className="text-[10px] font-mono text-[#06d6a0] bg-[#06d6a0]/10 border border-[#06d6a0]/20 rounded-full px-2.5 py-1">Q4 · 41s saved</span>
        <span className="text-[10px] font-mono text-[#ef476f] bg-[#ef476f]/10 border border-[#ef476f]/20 rounded-full px-2.5 py-1">Q7 · took the bait</span>
        <span className="text-[10px] font-mono text-[#ffd166] bg-[#ffd166]/10 border border-[#ffd166]/20 rounded-full px-2.5 py-1">Reading · 9s faster</span>
      </div>
    </div>
  );
}

function AskNinjaMock() {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <p className="bg-[#1c1c1c] text-[#c5e8f0] text-sm rounded-lg rounded-br-sm px-3.5 py-2.5 max-w-[85%]">
          Why is B wrong? The passage seems to say exactly that.
        </p>
      </div>
      <div className="flex gap-2.5">
        <span className="w-6 h-6 rounded-full bg-[#06d6a0] flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
          <NinjaLogo color="#120F17" className="w-4 h-4" />
        </span>
        <p className="text-[#c5e8f0] text-sm leading-relaxed">
          It says it, but as an example — not as the point. The actual claim is in
          the last paragraph, and D is the only option that repeats it without
          quietly adding &ldquo;always&rdquo;.
        </p>
      </div>
    </div>
  );
}

function PracticeMock() {
  const rows = [
    { s: "Logic", c: "#ffd166", t: "Circular seating · 6 people", d: "you skipped this type" },
    { s: "Logic", c: "#ffd166", t: "Linear seating · clue chains", d: "you start too slow" },
    { s: "Verbal", c: "#118ab2", t: "What is the author's point?", d: "you took the bait" },
  ];
  return (
    <div>
      <MockHead icon={<Sparkles size={11} className="text-[#ffd166]" />} label="Built from your last 5 matches" />
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
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-[#9f84bd]/15 border border-[#9f84bd]/30 flex items-center justify-center overflow-hidden">
            <NinjaLogo color="#9f84bd" className="w-5 h-5" />
          </span>
          <div>
            <p className="text-white text-sm font-semibold leading-none">NINJA-BOT</p>
            <p className="text-[#4a8fa8] text-[10px] font-mono mt-1">playing at your level · rating safe</p>
          </div>
        </div>
        <span className="text-[10px] font-mono text-[#7ab5cc] bg-[#7ab5cc]/10 border border-[#7ab5cc]/20 rounded-full px-2.5 py-1">Q 5 / 9</span>
      </div>
      <div className="flex items-center gap-4 bg-[#1c1c1c] rounded-lg px-4 py-3">
        <span className="w-2 h-2 rounded-full bg-[#06d6a0] animate-pulse shrink-0" />
        <p className="text-[#c5e8f0] text-xs flex-1">Bot is still reading…</p>
        <span className="font-pixel text-sm text-[#ffd166]">0:47</span>
      </div>
    </div>
  );
}

/* ── S5: matchmaking charts ──
   Redrawn 2026-07-26 as minimal line charts: one hairline baseline, no fill,
   no floating annotations, one endpoint dot, labels in plain English. The old
   version stacked three grid lines, a tinted area, two callouts and a formula
   caption on a 270px canvas and read as an engineering plot. */

const CH = { w: 560, h: 180, padX: 8, top: 16, bot: 150 };

function line(points: [number, number][]) {
  return points
    .map(([t, v]) => {
      const x = CH.padX + t * (CH.w - CH.padX * 2);
      const y = CH.bot - v * (CH.bot - CH.top);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function MiniChart({
  label, points, xLeft, xRight, note, accent = "#06d6a0",
}: {
  label: string; points: [number, number][]; xLeft: string; xRight: string; note: string; accent?: string;
}) {
  const last = points[points.length - 1];
  return (
    <div className="rounded-2xl border border-[#222222] bg-[#111111] p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a8fa8]">{label}</p>
      <p className="mt-2 text-[#c5e8f0] text-sm leading-relaxed">{note}</p>
      <svg viewBox={`0 0 ${CH.w} ${CH.h}`} className="mt-5 w-full" role="img" aria-label={`${label} — ${note}`}>
        <line x1={CH.padX} y1={CH.bot} x2={CH.w - CH.padX} y2={CH.bot} stroke="#222222" strokeWidth="1" />
        <polyline
          points={line(points)}
          fill="none"
          stroke={accent}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={CH.padX + last[0] * (CH.w - CH.padX * 2)}
          cy={CH.bot - last[1] * (CH.bot - CH.top)}
          r="3"
          fill={accent}
        />
        <text x={CH.padX} y={CH.h - 6} fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">{xLeft}</text>
        <text x={CH.w - CH.padX} y={CH.h - 6} textAnchor="end" fill="#4a8fa8" fontSize="10" fontFamily="var(--font-geist-mono)">{xRight}</text>
      </svg>
    </div>
  );
}

function MatchmakingViz() {
  // How wide we search, over time waited. Normalised 0..1 on both axes.
  const search: [number, number][] = Array.from({ length: 61 }, (_, s) => [
    s / 60,
    Math.min(1000, 100 + 20 * s) / 1000,
  ]);

  // What beating someone is worth, as they get weaker than you.
  const worth: [number, number][] = Array.from({ length: 41 }, (_, i) => {
    const gap = i * 20;
    const e = 1 / (1 + 10 ** (-gap / 400));
    return [gap / 800, ((1 - e) * (2.2 / (0.001 * gap + 2.2))) / 0.5];
  });

  return (
    <Reveal>
      <div className="grid gap-4 md:grid-cols-2">
        <MiniChart
          label="Finding you a game"
          note="We start by looking for someone almost exactly your level, then quietly relax it. Nobody waits forever."
          points={search}
          xLeft="the moment you tap play"
          xRight="a minute later"
        />
        <MiniChart
          accent="#ffd166"
          label="What a win is worth"
          note="An even fight pays full price. Beating someone well below you barely moves your rating — so there is nothing to farm."
          points={worth}
          xLeft="an even fight"
          xRight="way below you"
        />
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

/* ── S2·5: the dashboard, as it actually ships ──
   Not a picture — the real lobby chrome rebuilt in place, so it stays sharp at
   any width and can never drift from the app's colours. Everything here mirrors
   app/lobby/lobby-client.tsx and components/side-nav.tsx; the countdown ring,
   speed meter and section chips are the app's OWN components imported straight
   in, so those can't drift at all. Static by design: no handlers, no data,
   nothing to hydrate. */

const SHOT_USER = { name: "Max Planck", handle: "maxplanck", initials: "MP", elo: 1480 };

/* The floating dock, exactly as it renders over every authed screen. Home is
   the active item (this is /lobby), and the Ninja AI item carries the mode
   marker so the two chat personalities are visible without a second screen. */
function ShotDock() {
  const items = [
    { icon: <Home size={18} />, label: "Home", active: true },
    { icon: <Users size={18} />, label: "Friends" },
    { icon: <Eye size={18} />, label: "Spectate" },
    { icon: <Trophy size={18} />, label: "Leaderboard" },
    { icon: <NinjaLogo color="#073b4c" className="w-[18px] h-[18px]" />, label: "Ninja AI", ninja: true },
    { icon: <Settings size={18} />, label: "Settings" },
    { icon: <LogOut size={18} />, label: "Sign out" },
  ];
  return (
    <nav
      aria-label="Ninjatest navigation dock"
      className="flex flex-col items-center gap-1 rounded-[1.75rem] px-1.5 py-2.5
        bg-gradient-to-b from-[#0be4ad] to-[#06d6a0] border border-[#3af0c8]/40
        shadow-[0_24px_60px_-12px_rgba(6,214,160,0.55),0_8px_20px_-6px_rgba(0,0,0,0.6)]"
    >
      {items.map(it => (
        <div className="relative" key={it.label}>
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-full text-[#073b4c] ${
              it.active ? "bg-[#073b4c]/15" : ""
            }`}
          >
            {it.icon}
          </span>

          {/* active route springs its label out beside the dock */}
          {it.active && (
            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-3 whitespace-nowrap rounded-md bg-[#073b4c] px-2.5 py-1 text-xs font-medium text-[#06d6a0]">
              {it.label}
            </span>
          )}

          {/* Ninja AI keeps its pill out permanently — it is the one dock item
              people do not guess from the glyph — and carries the mode marker,
              so both live in the dock's own gutter and overlap nothing. */}
          {it.ninja && (
            <div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 w-[180px]">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#073b4c] px-2.5 py-1 text-xs font-medium text-[#06d6a0]">
                <NinjaLogo className="w-3 h-3" color="#06d6a0" /> Ninja AI
              </span>
              <ShotNinjaModes />
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

/* The Ninja chat's own mode switcher, lifted out of app/ninja/chat-client.tsx.
   Buddy is the marked one: socratic — it will not hand over the answer. */
function ShotNinjaModes() {
  return (
    <div className="mt-1.5 rounded-xl border border-[#333333] bg-[#111111] p-1.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.95)]">
      <NinjaMode hint="Grounded in your stats" icon={<BarChart3 size={13} className="text-[#06d6a0]" />} label="Coach" />
      <NinjaMode hint="Socratic — hints, not answers" icon={<Lightbulb size={13} className="text-[#ffd166]" />} label="Buddy" marked />
    </div>
  );
}

function NinjaMode({ icon, label, hint, marked }: { icon: React.ReactNode; label: string; hint: string; marked?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
        marked ? "bg-[#ffd166]/10 ring-1 ring-[#ffd166]/40" : ""
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-white text-[11px] leading-none">{label}</p>
        <p className="text-[#4a8fa8] text-[9px] mt-1 leading-tight">{hint}</p>
      </div>
      {marked && <Check className="text-[#ffd166] shrink-0" size={11} />}
    </div>
  );
}

/* Live match, mid-question. Uses the real CountdownRing + SpeedMeter so the
   numbers here are computed by the same code that runs in a battle: QUANT cap
   105s, 65s left → 13 grace blocks × ×2 = +26 pts. */
function ShotMatch() {
  const capMs = 105_000, remaining = 65_000;
  const progress = remaining / capMs;
  const options = ["30", "34", "36", "38"];
  return (
    <div className="h-full flex flex-col rounded-2xl border border-[#222222] bg-[#120F17] overflow-hidden shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95)]">
      {/* top bar */}
      <div className="border-b border-[#222222] px-4 py-3 shrink-0">
        <div className="flex items-center justify-center gap-1.5 mb-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <span
              key={i}
              className={`rounded-full ${
                i < 5 ? "w-2 h-2 bg-[#06d6a0]/60" : i === 5 ? "w-3 h-3 bg-[#06d6a0]" : "w-2 h-2 bg-[#1a6080]"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <ShotPlayer initials={SHOT_USER.initials} name={SHOT_USER.name} score={412} />
          <CountdownRing progress={progress} remaining={remaining} section="QUANT" size={48} />
          <ShotPlayer answered initials="AL" name="ada_l" right score={366} />
        </div>
      </div>

      {/* question */}
      <div className="flex-1 px-4 py-4 space-y-3.5">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${getSectionBadgeClass("QUANT")}`}>QUANT</span>
          <span className="text-[#7ab5cc] text-sm">Q6 of 9</span>
        </div>

        <SpeedMeter capMs={capMs} progress={progress} section="QUANT" timeRemaining={remaining} />

        <p className="text-white text-[15px] leading-relaxed">
          The average of five numbers is 26. One number is removed and the average
          of the remaining four is 24. Which number was removed?
        </p>

        <div className="space-y-2">
          {options.map((o, i) => (
            <div
              key={o}
              className={`w-full px-4 py-2.5 rounded-xl border text-sm ${
                i === 1
                  ? "border-[#06d6a0]/40 bg-[#06d6a0]/5 text-white"
                  : "border-[#222222] bg-[#111111] text-white"
              }`}
            >
              <span className="text-[#7ab5cc] font-mono mr-2.5">{String.fromCharCode(65 + i)}.</span>
              {o}
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-1 pt-0.5">
          <span className="text-[#7ab5cc] text-sm">Skip · 0 pts</span>
          <span className="text-[#4a8fa8] text-xs">Wrong answers lose points</span>
        </div>
      </div>
    </div>
  );
}

function ShotPlayer({ initials, name, score, right, answered }: {
  initials: string; name: string; score: number; right?: boolean; answered?: boolean;
}) {
  return (
    <div className={`flex-1 flex items-center gap-2 min-w-0 ${right ? "flex-row-reverse" : ""}`}>
      <span className="w-8 h-8 shrink-0 rounded-full bg-[#120F17] border border-white/10 grid place-items-center text-[#06d6a0] text-[10px] font-bold">
        {initials}
      </span>
      <div className={`min-w-0 ${right ? "text-right" : "text-left"}`}>
        <p className="text-white text-[13px] font-semibold truncate">{name}</p>
        <p className="text-[#ffd166] font-bold text-lg leading-none">{score}</p>
        {answered && <p className="text-[#7ab5cc] text-xs">answered</p>}
      </div>
    </div>
  );
}

function DashboardShot() {
  const league = getLeague(SHOT_USER.elo);
  const modes = [
    { icon: Zap,    title: "Ranked 1v1",        sub: "Mixed set · counts towards your rating", primary: true },
    { icon: Users,  title: "Challenge a friend", sub: "Send a code · rated or just for fun" },
    { icon: Target, title: "Practice",           sub: "Solo drill · aims at your weak spots" },
    { icon: Bot,    title: "Vs Ninja Bot",       sub: "Instant game · plays at your level" },
    { icon: Eye,    title: "Spectate",           sub: "Watch live matches" },
    { icon: Trophy, title: "Leaderboard",        sub: "This season's top 100" },
  ];
  // Last ten rated results, oldest → newest. Drawn as a hairline, no axes.
  const curve = [1310, 1298, 1345, 1362, 1351, 1399, 1428, 1412, 1466, 1480];
  const lo = Math.min(...curve), hi = Math.max(...curve);
  const spark = curve
    .map((v, i) => `${(i / (curve.length - 1)) * 200},${28 - ((v - lo) / (hi - lo)) * 24}`)
    .join(" ");

  return (
    <section className="px-4 sm:px-10 py-12 border-b border-[#222222]">
      <Reveal>
        <p className="text-center font-mono text-[10px] uppercase tracking-[0.3em] text-[#c5e8f0]/40 mb-6">
          This is the whole thing
        </p>

        {/* Lobby and live match sit side by side and never overlap — one row,
            both panels stretched to the same height, the pair sized to land
            inside a single viewport. Below xl the match stacks underneath. */}
        <div className="mx-auto max-w-[1360px] flex flex-col xl:flex-row items-stretch gap-4">
          <div className="flex-1 min-w-0 rounded-2xl border border-[#222222] bg-[#0d0b12] overflow-hidden shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
            {/* window chrome */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1c1a24] bg-[#111111]">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ef476f]/50" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#ffd166]/50" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#06d6a0]/50" />
              <span className="ml-3 font-mono text-[10px] text-[#4a8fa8]">ninjatest.app/lobby</span>
            </div>

            <div className="relative p-5 sm:p-6 xl:pl-[16.5rem]">
              {/* the dock floats over the lobby exactly like this in the app */}
              <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 hidden xl:block">
                <ShotDock />
              </div>

              {/* greeting */}
              <div className="flex items-center justify-between gap-3 mb-6">
                <div>
                  <h3 className="font-pixel text-xl">
                    Welcome, <span className="text-[#06d6a0]">{SHOT_USER.name}</span>
                  </h3>
                  <p className="text-[#4a8fa8] text-sm mt-1">Pick a mode to enter a battle.</p>
                </div>
                <span className="hidden sm:flex items-center gap-1.5 bg-[#06d6a0]/10 border border-[#06d6a0]/20 rounded-full px-2.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#06d6a0] animate-pulse" />
                  <span className="text-[#06d6a0] text-xs font-medium">312 online</span>
                </span>
              </div>

              {/* fixed rail track rather than a 1/3 column — at this width a
                  fractional rail squeezed the display name and wrapped "Win rate". */}
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_244px] gap-5">
                {/* modes */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {modes.map(m => {
                    const Icon = m.icon;
                    return (
                      <div
                        key={m.title}
                        className={`rounded-2xl p-4 ${
                          m.primary
                            ? "bg-gradient-to-br from-[#06d6a0] to-[#05b088] text-[#073b4c]"
                            : "bg-[#111111] border border-[#1c1a24]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <Icon size={18} className={m.primary ? "" : "text-[#06d6a0]"} />
                          <ChevronRight size={15} className={m.primary ? "opacity-60" : "text-[#4a8fa8]"} />
                        </div>
                        <div className="mt-4">
                          <div className={`font-pixel text-base ${m.primary ? "" : "text-white"}`}>{m.title}</div>
                          <div className={`text-xs mt-0.5 ${m.primary ? "text-[#073b4c]/80" : "text-[#7ab5cc]"}`}>{m.sub}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* right rail */}
                <aside className="rounded-2xl border border-white/10 bg-[#111111] p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="w-11 h-11 shrink-0 rounded-full bg-[#120F17] border border-white/10 grid place-items-center text-sm font-bold text-[#06d6a0]">
                      {SHOT_USER.initials}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white truncate">{SHOT_USER.name}</p>
                        <span
                          className="shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-medium"
                          style={{ color: league.color, borderColor: `${league.color}4d`, background: `${league.color}1a` }}
                        >
                          {league.name}
                        </span>
                      </div>
                      <p className="text-[#7ab5cc] text-xs">@{SHOT_USER.handle}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <Flame size={11} className="text-[#ffd166]" />
                        <span className="text-[#ffd166] text-xs font-semibold">4 win streak</span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t border-white/10 pt-3">
                    {[
                      { l: "Rating", v: String(SHOT_USER.elo), c: "#ffd166" },
                      { l: "Win rate", v: "63%", c: "#06d6a0" },
                      { l: "Best", v: "1512", c: "#ffd166" },
                    ].map(s => (
                      <div key={s.l}>
                        <p className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-wider">{s.l}</p>
                        <p className="font-pixel text-lg mt-0.5" style={{ color: s.c }}>{s.v}</p>
                      </div>
                    ))}
                  </div>

                  {/* rating over the last ten games — hairline, no axes */}
                  <div className="border-t border-white/10 pt-3">
                    <p className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-wider mb-2">Last 10 games</p>
                    <svg viewBox="0 0 200 32" className="w-full h-8" role="img" aria-label="Rating over the last ten games, trending up">
                      <polyline points={spark} fill="none" stroke="#06d6a0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="200" cy={28 - ((curve[curve.length - 1] - lo) / (hi - lo)) * 24} r="2.5" fill="#06d6a0" />
                    </svg>
                  </div>

                  {/* how each part of the paper is going — real app section chips */}
                  <div className="border-t border-white/10 pt-3 space-y-2">
                    <p className="text-[#4a8fa8] text-[10px] font-mono uppercase tracking-wider">By section</p>
                    {[
                      { s: "VARC" as const,  label: "Verbal", pct: 71 },
                      { s: "DILR" as const,  label: "Logic",  pct: 54 },
                      { s: "QUANT" as const, label: "Quant",  pct: 82 },
                    ].map(r => (
                      <div key={r.label} className="flex items-center gap-2.5">
                        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-mono ${getSectionBadgeClass(r.s)}`}>
                          {r.label}
                        </span>
                        <div className="h-1 flex-1 rounded-full bg-white/8 overflow-hidden">
                          <div className="h-full rounded-full bg-white/25" style={{ width: `${r.pct}%` }} />
                        </div>
                        <span className="font-mono text-[10px] text-[#4a8fa8] w-8 text-right">{r.pct}%</span>
                      </div>
                    ))}
                  </div>

                </aside>
              </div>
            </div>
          </div>

          {/* the live match, as its own panel beside the lobby */}
          <div className="w-full mx-auto max-w-[380px] xl:mx-0 xl:w-[376px] xl:max-w-none shrink-0">
            <ShotMatch />
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ── S2a: institute crest ticker ──
   ponytail: crests are white-stripped PNGs (scratch script, PIL unpremultiply) rendered as
   white silhouettes — the source marks are dark ink and would vanish on #120F17. */
function InstituteMarquee() {
  const schools = [
    { name: "IIM Ahmedabad", src: "/logos/iim-ahmedabad.svg" },
    { name: "IIT Delhi", src: "/logos/iit-delhi.png" },
    { name: "IIT Kharagpur", src: "/logos/iit-kharagpur.png" },
    { name: "IIM Kozhikode", src: "/logos/iim-kozhikode.png" },
    { name: "IIT Roorkee", src: "/logos/iit-roorkee.png" },
    { name: "IIT Mandi", src: "/logos/iit-mandi.png" },
  ];
  return (
    <div className="border-b border-[#222222] py-8">
      <p className="text-center font-mono text-[10px] uppercase tracking-[0.3em] text-[#c5e8f0]/40">
        Vetted by students of
      </p>
      <div className="mt-6 overflow-hidden">
        <div className="flex items-center animate-marquee hover:[animation-play-state:paused]" style={{ width: "max-content" }}>
          {[...schools, ...schools, ...schools, ...schools].map((s, i) => (
            <div key={i} className="shrink-0 px-9">
              <Image
                src={s.src}
                alt={s.name}
                title={s.name}
                width={56}
                height={56}
                className="h-14 w-auto object-contain opacity-45 hover:opacity-90 transition-opacity"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── S2: marquee ticker ── */
function LogoMarquee() {
  const items = [
    "GMAT", "CAT", "GRE", "LSAT", "JEE", "UPSC", "NEET", "MCAT", "SAT", "UCAT", "ACT", "TSA",
    "MATCHED IN SECONDS", "NINE QUESTIONS", "REAL RATING",
    "NEW SEASON EVERY MONTH", "WATCH LIVE MATCHES", "NO WAY TO CHEAT",
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
