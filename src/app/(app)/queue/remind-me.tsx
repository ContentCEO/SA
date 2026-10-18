"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { snoozeAction } from "./actions";
import { CardTargets, closeOnEscape, QuestionLine, useFocusReturn } from "./focus";

export type SnoozeOption = { choice: string; label: string };

/** A half-row button whose words may wrap (still at least 44px tall). */
export const COMPACT = "h-auto min-h-11 w-full py-2 leading-tight whitespace-normal";

/** Plan #6: put a conversation off; it comes back on top of the queue. */
export function RemindMe({
  threadId,
  nextThreadId,
  options,
  inverted,
  compact,
}: {
  threadId: string;
  /** Check 9 P5: the card a snooze lands on. */
  nextThreadId?: string | null;
  options: SnoozeOption[];
  inverted?: boolean;
  /** Check 9 P12: half a row wide — the words may wrap onto two lines. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { opener, restore } = useFocusReturn();
  const titleId = useId();
  if (!options.length) return null;
  // Check 32 P1: Never mind (or Escape) puts focus back on Remind me later.
  const close = () => {
    restore();
    setOpen(false);
  };
  return open ? (
    <form
      action={snoozeAction}
      className="flex flex-col gap-2"
      aria-labelledby={titleId}
      onKeyDown={closeOnEscape(close)}
    >
      <CardTargets threadId={threadId} next={nextThreadId} />
      <QuestionLine id={titleId} className="font-semibold">
        Remind me…
      </QuestionLine>
      {options.map((o) => (
        <Button
          key={o.choice}
          type="submit"
          name="choice"
          value={o.choice}
          variant={inverted ? "default" : "outline"}
          className="w-full"
        >
          {o.label}
        </Button>
      ))}
      <Button type="button" variant="ghost" className="w-full" onClick={close}>
        Never mind
      </Button>
    </form>
  ) : (
    <Button
      ref={opener}
      type="button"
      variant={inverted ? "default" : "outline"}
      className={compact ? COMPACT : "w-full"}
      onClick={() => setOpen(true)}
    >
      Remind me later
    </Button>
  );
}
