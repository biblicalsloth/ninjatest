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
