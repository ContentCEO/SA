"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Check 9 P2: the words for the time left. Minutes, then seconds in the last minute. */
export function countdownWords(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  if (s === 0) return "Sending now…";
  if (s < 60) return `Sends in ${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `Sends in ${m} min`;
}

/**
 * Check 9 P2: a live countdown on an autopilot reply ("Sends in 6 min", then seconds). Screen
 * readers get the clock time once, never every tick. At zero the queue refreshes every few
 * seconds until the card is gone (sent) or held.
 */
export function AutopilotCountdown({ sendAt, clock }: { sendAt: string; clock: string }) {
  const router = useRouter();
  const end = new Date(sendAt).getTime();
  const [left, setLeft] = useState(() => end - Date.now());

  useEffect(() => {
    const tick = setInterval(() => {
      const ms = end - Date.now();
      setLeft(ms);
      if (ms <= 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [end]);

  const due = left <= 0;
  useEffect(() => {
    if (!due) return;
    router.refresh();
    let tries = 0;
    const poll = setInterval(() => {
      router.refresh();
      // A minute of tries; the 15-minute backstop sends a late one, and the next visit shows it.
      if (++tries >= 15) clearInterval(poll);
    }, 4000);
    return () => clearInterval(poll);
  }, [due, router]);

  return (
    <p>
      <span className="sr-only">Autopilot sends this at {clock} unless you hold it.</span>
      <span aria-hidden="true">
        <span className="font-black" suppressHydrationWarning>
          {countdownWords(left)}
        </span>{" "}
        <span className="text-ash">
          {due ? "Autopilot is sending it." : `(at ${clock}) unless you hold it.`}
        </span>
      </span>
    </p>
  );
}
