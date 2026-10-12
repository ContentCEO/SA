"use client";

import { useEffect } from "react";
import { applyBadge } from "@/lib/app-badge";
import { clearIntents, OFFLINE_CACHE } from "@/lib/offline-intents";

/**
 * Plan #10: on any signed-out screen, delete the queue copy and stored okays
 * an opted-in phone may hold, and clear the home-screen badge (plan #38).
 * Signing out leaves nothing behind.
 */
export function ForgetOffline() {
  useEffect(() => {
    if ("caches" in window) caches.delete(OFFLINE_CACHE).catch(() => {});
    clearIntents();
    void applyBadge(navigator, 0);
  }, []);
  return null;
}
