"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Check 8 P3: one small line under a tab screen's headline saying when the list was fetched,
 * in the owner's time (`time` is formatted by the server). With no signal (the saved copy of
 * the queue, or a screen left open) it says how old what's shown is.
 */
export function UpdatedAt({ time, what }: { time: string; what: string }) {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return (
    <p data-updated-at="" className="-mt-6 text-sm text-muted-foreground">
      {online ? `Updated ${time}` : `No signal. This is your ${what} from ${time}.`}
    </p>
  );
}
