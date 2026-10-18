"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Check 9 P14: what a screen reader hears once when a swipe starts a discard. */
export const DISCARD_SPOKEN = "Discarding in 5 seconds. Undo to keep it.";

/**
 * The swipe-to-discard countdown's words. The status line never changes (said once); the
 * ticking number is for the eye only.
 */
export function DiscardCountdown({ left }: { left: number }) {
  return (
    <>
      <p role="status" className="sr-only">
        {left > 0 ? DISCARD_SPOKEN : "Discarding."}
      </p>
      <p className="font-semibold" aria-hidden>
        {left > 0 ? `Discarding in ${left}… It's removed from Gmail too.` : "Discarding…"}
      </p>
    </>
  );
}

/**
 * Check 9 P14: while a card is dragged, the strip it uncovers says what letting go does —
 * "Open" on the side that opens it for sending, "Discard" on the other. For the eye only
 * (the buttons do the same without a drag). Charcoal on paper; mirrored for a left thumb.
 */
export function SwipeLabel({ dx, toSend }: { dx: number; toSend: 1 | -1 }) {
  if (!dx) return null;
  const opens = dx * toSend > 0;
  // The card moved right → the strip on its left is showing, and the other way round.
  const side = dx > 0 ? "left-0 justify-start" : "right-0 justify-end";
  return (
    <div
      aria-hidden
      data-testid="swipe-label"
      className={`absolute inset-y-0 flex w-1/2 items-center rounded-xl bg-paper px-4 text-lg font-black text-charcoal ${side}`}
    >
      {opens ? "Open" : "Discard"}
    </div>
  );
}

const TIP_KEY = "sa_swipe_tip_seen";

/**
 * Check 9 P14: a one-time tip on the first draft card, on touch phones only. Remembered on this
 * phone (localStorage); a phone where storage fails simply shows it again next time.
 */
export function SwipeTip({ leftHanded }: { leftHanded?: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(TIP_KEY) === "1";
    } catch {
      seen = false;
    }
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
    setShow(touch && !seen);
  }, []);
  if (!show) return null;
  const [open, discard] = leftHanded ? ["left", "right"] : ["right", "left"];
  return (
    <div
      data-testid="swipe-tip"
      className="flex flex-col gap-2 rounded-lg border-2 border-charcoal p-3"
    >
      <p className="font-semibold">
        Swipe {open} to open, {discard} to discard. A swipe never sends.
      </p>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => {
          try {
            window.localStorage.setItem(TIP_KEY, "1");
          } catch {
            // Storage blocked: it shows again next time, nothing else.
          }
          setShow(false);
        }}
      >
        Got it
      </Button>
    </div>
  );
}
