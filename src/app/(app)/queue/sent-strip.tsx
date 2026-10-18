"use client";

import { useEffect, useRef } from "react";

/**
 * After Send reply (Check 9 P5, Check 32 P7): the "reply on its way, squared away." box sits in
 * a strip fixed above the phone's tab bar, so it and its Undo stay in view while the page lands
 * on the next card. Its first line is the page's h1 (it replaces the queue's heading). Focus
 * moves to it once, when it first appears, so a screen reader reads the heading and the next Tab
 * is Undo; the undo window's refreshes keep this component mounted, so focus isn't taken again.
 */
export function SentStrip({
  serif,
  heavy,
  children,
}: {
  serif: string;
  heavy: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Fixed on screen: no scroll needed, and the page stays on the card it landed on.
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby="sent-heading"
      aria-live="polite"
      data-testid="sent-strip"
      className="sa-inverted fixed inset-x-0 bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-h-[60vh] w-[calc(100%-2rem)] max-w-[calc(36rem-2rem)] animate-in flex-col gap-2 overflow-y-auto rounded-xl p-4 shadow-lg duration-500 outline-none fade-in sm:bottom-4"
    >
      <h1 id="sent-heading" className="flex flex-wrap items-baseline gap-x-2">
        <span className="sa-headline-serif text-2xl">{serif}</span>{" "}
        <span className="sa-headline-heavy text-2xl">{heavy}</span>
      </h1>
      {children}
    </section>
  );
}
