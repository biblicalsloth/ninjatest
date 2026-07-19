import { AuthPanel } from "@/components/auth-panel";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  // Same open-redirect guard as /auth/callback: same-origin paths only.
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
      ? next
      : undefined;
  return (
    <AuthPanel
      defaultMode="signin"
      next={safeNext}
      callbackError={error === "auth_callback_failed"}
    />
  );
}
