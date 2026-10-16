"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { snoozeAction } from "./actions";

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
  if (!options.length) return null;
  return open ? (
    <form action={snoozeAction} className="flex flex-col gap-2" aria-label="Remind me">
      <input type="hidden" name="threadId" value={threadId} />
      <p className="font-semibold">Remind me…</p>
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
      <Button type="button" variant="ghost" className="w-full" onClick={() => setOpen(false)}>
        Never mind
      </Button>
    </form>
  ) : (
    <Button
      type="button"
      variant={inverted ? "default" : "outline"}
      className="w-full"
      onClick={() => setOpen(true)}
    >
      Remind me later
    </Button>
  );
}
