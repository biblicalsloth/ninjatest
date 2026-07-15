/* Full brand lockup — mirrors ninjatest_logo.svg. onMint = dark mark for mint backgrounds. */
export function NinjatestLogo({ onMint = false, className = "" }: { onMint?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        className={`w-8 h-8 rounded-full flex items-center justify-center overflow-hidden shrink-0 ${
          onMint ? "bg-[#120F17]" : "bg-[#06d6a0]"
        }`}
      >
        <NinjaLogo color={onMint ? "#06d6a0" : "#120F17"} className="w-5 h-5" />
      </span>
      {/* Geist 700, letter-spacing -1.5/40em — exact match to ninjatest_logo.svg wordmark */}
      <span className={`font-brand font-bold text-xl tracking-[-0.0375em] ${onMint ? "text-[#120F17]" : "text-white"}`}>
        Ninjatest
      </span>
    </span>
  );
}

export function NinjaLogo({ color = "currentColor", className }: { color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-label="Ninjatest">
      {/* Top headwrap */}
      <rect x="3" y="2.5" width="18" height="8" rx="3" fill={color} />
      {/* Lower face mask */}
      <rect x="3" y="13.5" width="18" height="8" rx="3" fill={color} />
      {/* Left eye slit */}
      <ellipse cx="8.5" cy="12" rx="2.2" ry="1.4" fill={color} />
      {/* Right eye slit */}
      <ellipse cx="15.5" cy="12" rx="2.2" ry="1.4" fill={color} />
    </svg>
  );
}
