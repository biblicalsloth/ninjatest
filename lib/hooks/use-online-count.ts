"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const CHANNEL = "global:online";

/**
 * Subscribes to the global presence channel.
 * If userId provided, tracks the user so they appear in the count.
 * Landing page (no auth) passes no userId — still sees the live count.
 * Presence key = userId deduplicates multiple tabs from same user.
 */
export function useOnlineCount(userId?: string) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase.channel(CHANNEL, {
      config: {
        presence: {
          key: userId ?? "anon-" + Math.random().toString(36).slice(2),
        },
      },
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      // Count unique keys (= unique users; same user across tabs shares one key)
      setCount(Object.keys(state).length);
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED" && userId) {
        await channel.track({ user_id: userId });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
}