"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-check the page every few seconds (a bounded number of times) — e.g. while Stripe confirms a payment. */
export function RefreshUntil({ everyMs = 3000, times = 10 }: { everyMs?: number; times?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      if (++n > times) return clearInterval(t);
      router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, times]);
  return null;
}
