"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { useGSAP, enterUp, prefersReduced } from "@/lib/motion";

// Placeholder pricing — no billing wired. [tier][currency][period].
const PRICING = {
  rookie: { usd: { mo: 0, yr: 0 }, inr: { mo: 0, yr: 0 } },
  challenger: { usd: { mo: 6, yr: 60 }, inr: { mo: 499, yr: 4990 } },
  grandmaster: { usd: { mo: 12, yr: 120 }, inr: { mo: 999, yr: 9990 } },
} as const;

type Currency = "usd" | "inr";
type Period = "mo" | "yr";
type Tier = keyof typeof PRICING;

const SYMBOL: Record<Currency, string> = { usd: "$", inr: "₹" };
const UNIT: Record<Period, string> = { mo: "/mo", yr: "/yr" };

const TIERS: {
  key: Tier;
  name: string;
  desc: string;
  popular?: boolean;
  features: string[];
}[] = [
  {
    key: "rookie",
    name: "Rookie",
    desc: "Get on the board — free forever.",
    features: [
      "3 ranked battles / day",
      "Basic ELO tracking",
      "Public leaderboard",
      "1 Ninja AI debrief / day",
    ],
  },
  {
    key: "challenger",
    name: "Challenger",
    desc: "For aspirants who battle every day.",
    popular: true,
    features: [
      "Unlimited ranked battles",
      "Full ELO + rating graph",
      "Unlimited Ninja AI coach",
      "Daily focus plans",
      "Friend challenges",
      "Spectate mode",
    ],
  },
  {
    key: "grandmaster",
    name: "Grandmaster",
    desc: "Everything, plus the AI heavy artillery.",
    features: [
      "Everything in Challenger",
      "Unlimited PDF solver",
      "7-day AI study plans",
      "Priority matchmaking",
    ],
  },
];

// Comparison table — true = included, false = not, string = value.
const COMPARE: { label: string; rookie: boolean | string; challenger: boolean | string; grandmaster: boolean | string }[] = [
  { label: "Ranked battles", rookie: "3 / day", challenger: "Unlimited", grandmaster: "Unlimited" },
  { label: "ELO + rating graph", rookie: "Basic", challenger: true, grandmaster: true },
  { label: "Public leaderboard", rookie: true, challenger: true, grandmaster: true },
  { label: "Ninja AI debrief", rookie: "1 / day", challenger: "Unlimited", grandmaster: "Unlimited" },
  { label: "Ninja AI coach", rookie: false, challenger: true, grandmaster: true },
  { label: "Daily focus plans", rookie: false, challenger: true, grandmaster: true },
  { label: "Friend challenges", rookie: false, challenger: true, grandmaster: true },
  { label: "Spectate mode", rookie: false, challenger: true, grandmaster: true },
  { label: "PDF solver", rookie: false, challenger: false, grandmaster: "Unlimited" },
  { label: "7-day AI study plans", rookie: false, challenger: false, grandmaster: true },
  { label: "Priority matchmaking", rookie: false, challenger: false, grandmaster: true },
];

function Cell({ v }: { v: boolean | string }) {
  if (v === true) return <Check className="w-4 h-4 text-[#06d6a0] mx-auto" />;
  if (v === false) return <X className="w-4 h-4 text-white/20 mx-auto" />;
  return <span className="text-[#c5e8f0]/80 text-sm">{v}</span>;
}

// Gold CTA — mint would vanish against the mint page bg.
const CTA =
  "inline-flex items-center justify-center gap-2 bg-[#ffd166] text-[#120F17] font-bold text-sm rounded-full px-6 py-3 hover:bg-[#ffdd85] transition-colors";

export default function PricingClient() {
  const [currency, setCurrency] = useState<Currency>("usd");
  const [period, setPeriod] = useState<Period>("mo");
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (prefersReduced() || !scope.current) return;
      enterUp(scope.current.querySelectorAll("[data-rise]"));
    },
    { scope }
  );

  return (
    <div ref={scope} className="min-h-screen bg-[#053b30] text-white">
      {/* Nav */}
      <nav className="px-6 sm:px-10 py-6 flex items-center justify-between">
        <Link href="/" className="font-pixel text-lg tracking-tight text-white hover:text-[#ffd166] transition-colors">
          Ninjatest
        </Link>
        <Link href="/auth/signup" className="text-[#ffd166] hover:text-white text-sm font-semibold transition-colors">
          Sign up →
        </Link>
      </nav>

      <div className="max-w-6xl mx-auto px-6 sm:px-10 pb-24">
        {/* Hero */}
        <header className="text-center pt-14 pb-10">
          <h1 data-rise className="font-pixel text-[clamp(2.4rem,5vw,4.2rem)] leading-[1.02] text-balance">
            Rate your prep.<br />
            <span className="text-[#ffd166]">Pick your arena.</span>
          </h1>
          <p data-rise className="mt-6 text-[#c5e8f0]/80 text-lg font-light max-w-[48ch] mx-auto leading-relaxed">
            Start free, upgrade when the daily battles aren&apos;t enough. Every plan is
            server-rated, real-time, and ruthless.
          </p>
        </header>

        {/* Toggle row */}
        <div data-rise className="flex flex-wrap items-center justify-center gap-4 mb-14">
          <Pill<Currency>
            value={currency}
            onChange={setCurrency}
            options={[
              { v: "usd", label: "USD" },
              { v: "inr", label: "INR" },
            ]}
          />
          <Pill<Period>
            value={period}
            onChange={setPeriod}
            options={[
              { v: "mo", label: "Monthly" },
              { v: "yr", label: "Yearly" },
            ]}
          />
          {period === "yr" && (
            <span className="bg-[#06d6a0]/15 border border-[#06d6a0]/30 text-[#06d6a0] text-xs font-semibold rounded-full px-3 py-1.5">
              Save ~17%
            </span>
          )}
        </div>

        {/* Tier cards */}
        <div className="grid gap-6 md:grid-cols-3 items-start">
          {TIERS.map((t) => {
            const price = PRICING[t.key][currency][period];
            const highlight = t.popular;
            return (
              <div
                key={t.key}
                data-rise
                className={`relative rounded-2xl bg-[#111111] p-7 flex flex-col ${
                  highlight
                    ? "border-2 border-[#ffd166] md:-translate-y-3 shadow-[0_0_40px_rgba(255,209,102,0.15)]"
                    : "border border-[#222222]"
                }`}
              >
                {highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#ffd166] text-[#120F17] text-xs font-bold rounded-full px-3 py-1">
                    Most Popular
                  </span>
                )}
                <h2 className="font-pixel text-xl">{t.name}</h2>
                <p className="text-[#7ab5cc] text-sm mt-2 min-h-[2.5rem]">{t.desc}</p>

                <div className="mt-5 flex items-end gap-1">
                  <span className={`font-mono text-2xl ${highlight ? "text-[#ffd166]" : "text-white/70"}`}>
                    {SYMBOL[currency]}
                  </span>
                  <span className={`font-mono text-5xl tabular-nums leading-none ${highlight ? "text-[#ffd166]" : "text-white"}`}>
                    {price}
                  </span>
                  <span className="font-mono text-sm text-white/40 mb-1.5">{UNIT[period]}</span>
                </div>

                <Link href="/auth/signup" className={`${CTA} mt-6 w-full`}>
                  {price === 0 ? "Start free →" : "Choose plan →"}
                </Link>

                <ul className="mt-7 space-y-3">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-[#c5e8f0]/85">
                      <Check className="w-4 h-4 text-[#06d6a0] mt-0.5 shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Comparison table */}
        <div data-rise className="mt-20">
          <h2 className="font-pixel text-2xl text-center mb-8">Compare plans</h2>
          <div className="overflow-x-auto rounded-2xl border border-[#222222] bg-[#111111]">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-[#222222]">
                  <th className="p-4 text-sm font-medium text-white/50">Feature</th>
                  <th className="p-4 text-sm font-semibold text-center">Rookie</th>
                  <th className="p-4 text-sm font-semibold text-center text-[#ffd166]">Challenger</th>
                  <th className="p-4 text-sm font-semibold text-center">Grandmaster</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row) => (
                  <tr key={row.label} className="border-b border-[#1a1a1a] last:border-0">
                    <td className="p-4 text-sm text-[#c5e8f0]/85">{row.label}</td>
                    <td className="p-4 text-center"><Cell v={row.rookie} /></td>
                    <td className="p-4 text-center bg-[#ffd166]/[0.03]"><Cell v={row.challenger} /></td>
                    <td className="p-4 text-center"><Cell v={row.grandmaster} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer CTA band */}
        <div data-rise className="mt-20 rounded-2xl border border-[#ffd166]/25 bg-[#111111] px-8 py-14 text-center">
          <h2 className="font-pixel text-[clamp(1.8rem,3.5vw,2.8rem)] leading-tight mb-4">
            Your percentile has an opponent.
          </h2>
          <p className="text-[#c5e8f0]/70 text-base max-w-[44ch] mx-auto mb-8">
            Sign up free, play your first rated battle in under a minute.
          </p>
          <Link href="/auth/signup" className={CTA}>
            Enter the arena →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Pill<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string }[];
}) {
  return (
    <div className="inline-flex items-center rounded-full bg-[#111111] border border-[#222222] p-1">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            value === o.v ? "bg-[#ffd166] text-[#120F17]" : "text-white/50 hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
