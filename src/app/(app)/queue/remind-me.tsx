"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { snoozeAction } from "./actions";
import { closeOnEscape, QuestionLine, useFocusReturn } from "./focus";

export type SnoozeOption = { choice: string; label: string };

/** Plan #6: put a conversation off; it comes back on top of the queue. */
export function RemindMe({
  threadId,
  options,
  inverted,
}: {
  threadId: string;
  options: SnoozeOption[];
  inverted?: boolean;
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
      <input type="hidden" name="threadId" value={threadId} />
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
      className="w-full"
      onClick={() => setOpen(true)}
    >
      Remind me later
    </Button>
  );
}
