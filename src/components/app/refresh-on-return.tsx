"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { returnDecision, takesTyping } from "@/lib/refresh-rules";

/** Is the owner typing or editing right now? Read from the page at the moment it matters. */
function busy() {
  const el = document.activeElement as HTMLElement | null;
  return {
    typing: !!el && el !== document.body && takesTyping(el as HTMLInputElement),
    editing: !!document.querySelector('[data-editing="true"]'),
  };
}

/**
 * Check 8 P3: coming back to the app after a minute or more fetches the screen again
 * (router.refresh(): server data only, scroll and typed text stay). Never while the owner is
 * typing or has a draft open in Edit / Change it; then it waits until they're done. Renders
 * nothing.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let hiddenAt: number | null = null;
    let waiting: ReturnType<typeof setInterval> | null = null;

    const stopWaiting = () => {
      if (waiting) clearInterval(waiting);
      waiting = null;
    };
    const check = () => {
      const d = returnDecision({ hiddenAt, now: Date.now(), ...busy() });
      if (d === "refresh") {
        hiddenAt = null;
        stopWaiting();
        router.refresh();
      } else if (d === "later") {
        // Closing an editor doesn't always move focus, so look again every second too.
        waiting ??= setInterval(check, 1000);
      } else stopWaiting();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt ??= Date.now();
        stopWaiting();
      } else if (document.visibilityState === "visible") check();
    };
    // The field losing focus: let the blur land first, then look.
    const onFocusOut = () => {
      if (waiting) setTimeout(check, 0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      stopWaiting();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [router]);
  return null;
}
