// Durable, IP-keyed rate limiter backed by Postgres (check_ip_rate_limit RPC).
//
// Replaces the old in-memory limiter, whose state was per serverless instance
// and reset on every cold start. State now lives in the `ip_rate_limit` table,
// so limits hold across instances and restarts.
//
// Fail-open: if the RPC errors (DB blip, network), we allow the request rather
// than block a signup/invite on limiter failure. Abuse resistance is still
// best-effort, just no longer amnesiac.

export async function rateLimitDb(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  key: string,
  fn: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number }
): Promise<{ ok: boolean; retryAfter: number }> {
  const { data, error } = await supabase.rpc("check_ip_rate_limit", {
    p_key: key,
    p_fn: fn,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) return { ok: true, retryAfter: 0 }; // fail-open
  const retryAfter = typeof data === "number" ? data : 0;
  return { ok: retryAfter === 0, retryAfter };
}

// Derive a stable client identifier from request headers. Falls back to a shared
// bucket when no IP is present (better to over-throttle than to leak through).
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
