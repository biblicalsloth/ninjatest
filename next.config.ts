import type { NextConfig } from "next";
import path from "path";

// Derive the Supabase origin so the CSP can allow its REST + realtime (wss)
// endpoints without using a wildcard.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let supabaseHttp = "";
let supabaseWs = "";
try {
  if (supabaseUrl) {
    const u = new URL(supabaseUrl);
    supabaseHttp = u.origin;
    supabaseWs = `wss://${u.host}`;
  }
} catch {
  // ignore malformed env at build time; CSP simply omits the origin
}

// Next.js currently needs 'unsafe-inline' for its injected bootstrap scripts and
// styles unless a nonce pipeline is wired through middleware. We keep a strict
// policy everywhere else (no object/embed, locked frame-ancestors, etc.).
const csp = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
  `object-src 'none'`,
  `img-src 'self' data: blob: https:`,
  `font-src 'self' data:`,
  `style-src 'self' 'unsafe-inline'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `connect-src 'self' ${supabaseHttp} ${supabaseWs}`.trim().replace(/\s+/g, " "),
  `worker-src 'self' blob:`,
  `upgrade-insecure-requests`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Never emit browser source maps in production builds (avoids shipping
  // readable original source / internal logic to clients).
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
