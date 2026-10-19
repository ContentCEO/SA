"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { undoSendAction } from "./actions";

function UndoButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Stopping…" : label}
    </Button>
  );
}

/**
 * Check 32 P7: what a screen reader hears about the undo window — one sentence that never
 * changes while the seconds tick (the visible count is hidden from it), then one line when the
 * time is up.
 */
export const UNDO_SPOKEN = `You have ${UNDO_WINDOW_SECONDS} seconds to undo.`;
export const UNDO_TIME_UP = "Time's up. Sending now.";

/**
 * Plan #7: the undo window. Counts down to the send time; Undo puts the
 * draft(s) back in the queue untouched. When it ends, refresh until the
 * server says it went.
 */
export function UndoSend({ draftIds, sendAt }: { draftIds: string[]; sendAt: string }) {
  const router = useRouter();
  const end = new Date(sendAt).getTime();
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((end - Date.now()) / 1000)));

  useEffect(() => {
    const tick = setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) clearInterval(tick);
    }, 250);
    return () => clearInterval(tick);
  }, [end]);

  useEffect(() => {
    if (left > 0) return;
    let tries = 0;
    const poll = setInterval(() => {
      router.refresh();
      // Check 9 P10: long enough (90 s) that a late send turns into "Still sending…" with
      // Stop it, which then checks every 10 s on its own.
      if (++tries >= 30) clearInterval(poll);
    }, 3000);
    return () => clearInterval(poll);
  }, [left, router]);

  const many = draftIds.length > 1;
  return (
    <div className="flex flex-col gap-2">
      {/* One region, said once at the start and once at the end — never per second. */}
      <p role="status" className="sr-only">
        {left === 0 ? UNDO_TIME_UP : UNDO_SPOKEN}
      </p>
      {left === 0 ? (
        <p className="font-semibold" aria-hidden>
          Sending now…
        </p>
      ) : (
        <form action={undoSendAction} className="flex flex-col gap-2">
          {draftIds.map((id) => (
            <input key={id} type="hidden" name="draftId" value={id} />
          ))}
          <p className="font-semibold" aria-hidden>
            Sending in {left} second{left === 1 ? "" : "s"}.
          </p>
          <UndoButton label={many ? `Undo all ${draftIds.length}` : "Undo"} />
        </form>
      )}
    </div>
  );
}
