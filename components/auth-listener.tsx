"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/*
 * Mounted once in the root layout, on every route (renders nothing). Reacts to
 * auth changes the server middleware can't catch without a navigation: access
 * token expiry/refresh failure and logout in another tab both fire SIGNED_OUT.
 * On SIGNED_OUT → hard replace to /auth/login: replace() drops the history entry
 * (Back can't return to the authed page) and forces a server round-trip.
 * The middleware redirect stays the authoritative gate; this is UX + defense.
 */
export function AuthListener() {
  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        document.cookie = "nt_onboarded=; path=/; max-age=0; samesite=lax";
        window.location.replace("/auth/login");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return null;
}
