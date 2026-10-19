"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Check 32 P1: the first line of a small question on a card ("Discard this draft? …",
 * "Remind me…", "Answered by phone? …"). Focus lands on it when the question opens, so a
 * keyboard or screen reader user hears the question first and the next Tab is its first button.
 * The form names itself with `aria-labelledby` pointing at this line's id. `outline-none` is on
 * this text only, never on a button.
 */
export function QuestionLine({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} id={id} tabIndex={-1} className={cn(className, "outline-none")}>
      {children}
    </p>
  );
}

/**
 * Check 9 P5: which card a tap came from and which comes next, so the action lands the owner
 * back on the card (a refusal, a save) or on the next one (a send, a discard, a snooze).
 */
export function CardTargets({ threadId, next }: { threadId: string; next?: string | null }) {
  return (
    <>
      <input type="hidden" name="threadId" value={threadId} />
      {next ? <input type="hidden" name="nextThreadId" value={next} /> : null}
    </>
  );
}

/** Escape inside a question does what Keep it / Never mind / Cancel does. */
export const closeOnEscape =
  (close: () => void) =>
  (e: React.KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

/**
 * Puts focus back on the button that opened a question once it's on the page again (it
 * re-mounts when the question closes). Call `restore()` right after the state change.
 */
export function useFocusReturn<T extends HTMLElement = HTMLButtonElement>() {
  const opener = useRef<T>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    opener.current?.focus();
  });
  return {
    opener,
    restore: () => {
      pending.current = true;
    },
  };
}
