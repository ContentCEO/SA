"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { actionLanding, badgeRefresher, badgeSupported } from "@/lib/app-badge";

// Kept across in-app navigations (the layout stays mounted; a full load starts afresh).
let refresher: ReturnType<typeof badgeRefresher> | null = null;

function maybeRefresh(force = false) {
  refresher ??= badgeRefresher(navigator, (url, init) => fetch(url, init));
  void refresher({ force });
}

/**
 * Plan #38: keeps the number on the home-screen icon in step with the queue — replies ready
 * plus emails that need the owner. Asks the light count route when a signed-in screen opens,
 * on a move to another screen and when the app comes back to the front, at most once a minute
 * (plan M8 A32). Two moments skip the minute, one request each: a queue action landing
 * (`?sent=` / `?done=` / `?error=`, the count just changed) and the app going to the background
 * (so the icon the owner sees next is the count they left). Does nothing at all where the phone
 * has no badge. Renders nothing.
 */
export function AppBadge() {
  const pathname = usePathname();
  const landing = actionLanding(useSearchParams()?.toString());

  useEffect(() => {
    if (!badgeSupported(navigator)) return;
    maybeRefresh(landing !== null);
  }, [pathname, landing]);

  useEffect(() => {
    if (!badgeSupported(navigator)) return;
    const onChange = () => {
      if (document.visibilityState === "visible") maybeRefresh();
      else if (document.visibilityState === "hidden") maybeRefresh(true);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return null;
}
