"use client";

import { useEffect } from "react";

const OFFLINE_REFRESH_KEY = "sa-offline-refreshed-on";

/**
 * Check 46 P5: at most once a day per phone, ask the worker to fetch the no-signal page
 * again, so an edit to public/offline.html reaches phones that already have the app.
 */
export function refreshOfflinePageDaily(
  worker: { postMessage: (m: unknown) => void } | null | undefined,
  today: string = new Date().toISOString().slice(0, 10),
) {
  if (!worker) return false;
  try {
    if (localStorage.getItem(OFFLINE_REFRESH_KEY) === today) return false;
  } catch {
    // No storage (private window): still ask, it's one small request.
  }
  worker.postMessage({ type: "refresh-offline" });
  try {
    localStorage.setItem(OFFLINE_REFRESH_KEY, today);
  } catch {
    // Not remembered: we may ask again next visit, which is harmless.
  }
  return true;
}

/** Registers the tiny offline-page service worker (production only). */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => refreshOfflinePageDaily(reg.active))
      .catch(() => {
        // Not fatal: the site works without it, just without the offline page.
      });
  }, []);
  return null;
}
