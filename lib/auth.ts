import { createClient } from "@/lib/supabase/client";

// Single logout path. Clears the Supabase session AND the nt_onboarded UX cookie
// (set unprotected in middleware) so the next user on this browser can't skip the
// onboarding gate. Callers do the redirect; the AuthListener also covers the
// cross-tab / token-expiry SIGNED_OUT case.
export async function signOut() {
  await createClient().auth.signOut();
  document.cookie = "nt_onboarded=; path=/; max-age=0; samesite=lax";
}
