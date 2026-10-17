"use client";

import { useState } from "react";
import { PendingButton } from "@/components/app/pending-button";
import { Button } from "@/components/ui/button";
import { answeredByPhoneAction } from "./first-week-actions";

/**
 * Round 2 (FW E11): "I called them". Trades answer by phone all the time; one tap (and a
 * confirm) marks the conversation answered: the waiting draft goes (from Gmail too), no nudge
 * follows, and it counts as answered. It all comes back if the customer writes again.
 */
export function CalledThem({
  threadId,
  hasDraft,
  inverted,
  label = "I called them",
  confirm = "Yes, I called them",
}: {
  threadId: string;
  hasDraft: boolean;
  inverted?: boolean;
  /** Leads package: "Done — I answered" / "Done — I called back" on lead cards. */
  label?: string;
  confirm?: string;
}) {
  const done = label !== "I called them";
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        type="button"
        variant={inverted ? "default" : "outline"}
        className="w-full"
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      action={answeredByPhoneAction}
      className={
        inverted
          ? "flex flex-col gap-2 rounded-lg border-2 border-current p-3"
          : "sa-inverted flex flex-col gap-2 rounded-lg p-3"
      }
    >
      <input type="hidden" name="threadId" value={threadId} />
      {done ? <input type="hidden" name="as" value="done" /> : null}
      <p className="font-semibold">
        {done
          ? "Answered them another way? It leaves this list and we won't nudge them."
          : hasDraft
            ? "Answered by phone? This draft is removed (from Gmail too) and we won't nudge them."
            : "Answered by phone? It leaves this list and we won't nudge them."}{" "}
        If they write again, it comes back.
      </p>
      <PendingButton pending="Saving…" className="w-full">
        {confirm}
      </PendingButton>
      <Button type="button" variant="ghost" className="w-full" onClick={() => setAsking(false)}>
        Keep it
      </Button>
    </form>
  );
}
