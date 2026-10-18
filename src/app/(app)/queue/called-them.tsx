"use client";

import { useId, useState } from "react";
import { PendingButton } from "@/components/app/pending-button";
import { Button } from "@/components/ui/button";
import { answeredByPhoneAction } from "./first-week-actions";
import { CardTargets, closeOnEscape, QuestionLine, useFocusReturn } from "./focus";
import { COMPACT } from "./remind-me";

/**
 * Round 2 (FW E11): "I called them". Trades answer by phone all the time; one tap (and a
 * confirm) marks the conversation answered: the waiting draft goes (from Gmail too), no nudge
 * follows, and it counts as answered. It all comes back if the customer writes again.
 */
export function CalledThem({
  threadId,
  nextThreadId,
  hasDraft,
  inverted,
  label = "I called them",
  confirm = "Yes, I called them",
  back,
  compact,
}: {
  threadId: string;
  /** Check 9 P5: the card the owner lands on afterwards. */
  nextThreadId?: string | null;
  hasDraft: boolean;
  inverted?: boolean;
  /** Leads package: "Done — I answered" / "Done — I called back" on lead cards. */
  label?: string;
  confirm?: string;
  /** Check 10 P1: the Inbox's cards come back to the Inbox. */
  back?: "inbox";
  /** Check 9 P12: half a row wide — the words may wrap onto two lines. */
  compact?: boolean;
}) {
  const done = label !== "I called them";
  const [asking, setAsking] = useState(false);
  const { opener, restore } = useFocusReturn();
  const titleId = useId();
  // Check 32 P1: Keep it (or Escape) puts focus back on the button that asked.
  const close = () => {
    restore();
    setAsking(false);
  };
  if (!asking) {
    return (
      <Button
        ref={opener}
        type="button"
        variant={inverted ? "default" : "outline"}
        className={compact ? COMPACT : "w-full"}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      action={answeredByPhoneAction}
      aria-labelledby={titleId}
      onKeyDown={closeOnEscape(close)}
      className={
        inverted
          ? "flex flex-col gap-2 rounded-lg border-2 border-current p-3"
          : "sa-inverted flex flex-col gap-2 rounded-lg p-3"
      }
    >
      <CardTargets threadId={threadId} next={nextThreadId} />
      {done ? <input type="hidden" name="as" value="done" /> : null}
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <QuestionLine id={titleId} className="font-semibold">
        {back === "inbox"
          ? hasDraft
            ? "Answered by phone? The waiting draft is removed (from Gmail too) and we won't nudge them."
            : "Answered by phone? It's no longer waiting on you and we won't nudge them."
          : done
            ? "Answered them another way? It leaves this list and we won't nudge them."
            : hasDraft
              ? "Answered by phone? This draft is removed (from Gmail too) and we won't nudge them."
              : "Answered by phone? It leaves this list and we won't nudge them."}{" "}
        If they write again, it comes back.
      </QuestionLine>
      <PendingButton pending="Saving…" className="w-full">
        {confirm}
      </PendingButton>
      <Button type="button" variant="ghost" className="w-full" onClick={close}>
        Keep it
      </Button>
    </form>
  );
}
