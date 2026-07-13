import { AuthPanel } from "@/components/auth-panel";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <AuthPanel defaultMode="signin" callbackError={error === "auth_callback_failed"} />;
}
