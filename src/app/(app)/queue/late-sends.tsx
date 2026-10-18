"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { undoSendAction } from "./actions";

function StopIt() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending} className="w-full">
      {pending ? "Stopping…" : "Stop it"}
    </Button>
  );
}

/**
 * Check 9 P10: replies whose undo window ended over a minute ago and that haven't gone yet (the
 * send job's event was lost; a backstop sends them within 15 minutes). They're hidden from the
 * queue meanwhile, so they're listed here with Stop it, and the screen checks every 10 seconds.
 */
export function LateSends({ items }: { items: { draftId: string; to: string }[] }) {
  const router = useRouter();
  useEffect(() => {
    if (!items.length) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [items.length, router]);
  if (!items.length) return null;
  return (
    <section aria-labelledby="late-sends" className="flex flex-col gap-3">
      <h2 id="late-sends" className="sr-only">
        Waiting to send
      </h2>
      {items.map((i) => (
        <form
          key={i.draftId}
          action={undoSendAction}
          className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
        >
          <input type="hidden" name="draftId" value={i.draftId} />
          <p className="font-black">Waiting to send: reply to {i.to}</p>
          <p>Still sending. This is taking longer than usual.</p>
          <StopIt />
        </form>
      ))}
    </section>
  );
}
