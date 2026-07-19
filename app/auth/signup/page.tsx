import { AuthPanel } from "@/components/auth-panel";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Same open-redirect guard as /auth/callback: same-origin paths only.
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
      ? next
      : undefined;
  return <AuthPanel defaultMode="signup" next={safeNext} />;
}
