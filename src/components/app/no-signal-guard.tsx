"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** Words the guard shows (exported for tests). */
export const NO_SIGNAL_BLOCKED =
  "No signal. Nothing was sent or changed. Try again when you have a bar.";
export const NO_SIGNAL_QUIET = "No signal right now.";

/**
 * Check 8 P1: with no signal, a tap on any button that runs a server action used to land on the
 * crash page ("something went wrong on our side") and lose what was typed. This stops the form
 * before it leaves — in the capture phase on `window`, ahead of React's own listener — and
 * says plainly that nothing was sent. A form marked `data-offline-ok` (the opt-in offline okay
 * on Send reply) is let through. A quieter line shows whenever the phone is offline, so the
 * owner knows before tapping. Rendered once in the signed-in layout.
 */
export function NoSignalGuard() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      if (navigator.onLine) return;
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (form?.closest("[data-offline-ok]")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setBlocked(true);
    };
    const onOnline = () => setBlocked(false);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  if (online) return null;
  return (
    <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 px-4 sm:bottom-4">
      <p
        role={blocked ? "alert" : "status"}
        className={
          blocked
            ? "sa-inverted mx-auto flex min-h-tap max-w-xl items-center rounded-lg px-4 py-3 font-black"
            : "mx-auto flex min-h-tap max-w-xl items-center rounded-lg border-2 border-charcoal bg-paper px-4 py-3 font-semibold"
        }
      >
        {blocked ? NO_SIGNAL_BLOCKED : NO_SIGNAL_QUIET}
      </p>
    </div>
  );
}
