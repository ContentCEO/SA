"use client";

import { useEffect } from "react";

/** Registers the tiny offline-page service worker (production only). */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the site works without it, just without the offline page.
    });
  }, []);
  return null;
}
