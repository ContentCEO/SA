"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { batchSendAction } from "../actions";

function SendAll({ n }: { n: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Sending…" : `Yes, send ${n} ${n === 1 ? "reply" : "replies"}`}
    </Button>
  );
}

/** Plan #5: one button, then one confirmation. The server re-checks each reply. */
export function BatchForm({ draftIds, categories }: { draftIds: string[]; categories: string[] }) {
  const [confirming, setConfirming] = useState(false);
  const n = draftIds.length;
  return confirming ? (
    <form action={batchSendAction} className="sa-inverted flex flex-col gap-2 rounded-xl p-4">
      {draftIds.map((id) => (
        <input key={id} type="hidden" name="draftId" value={id} />
      ))}
      {categories.map((c) => (
        <input key={c} type="hidden" name="category" value={c} />
      ))}
      <p className="font-semibold">
        Send these {n} {n === 1 ? "reply" : "replies"} now? Each one is checked again before it
        goes, and you get a few seconds to undo.
      </p>
      <SendAll n={n} />
      <Button type="button" variant="ghost" className="w-full" onClick={() => setConfirming(false)}>
        Not yet
      </Button>
    </form>
  ) : (
    <Button type="button" size="lg" className="w-full" onClick={() => setConfirming(true)}>
      Send {n} {n === 1 ? "reply" : "replies"}
    </Button>
  );
}
