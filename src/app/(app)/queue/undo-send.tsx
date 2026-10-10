"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
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
      if (++tries >= 10) clearInterval(poll);
    }, 3000);
    return () => clearInterval(poll);
  }, [left, router]);

  if (left === 0) return <p className="font-semibold">Sending now…</p>;
  const many = draftIds.length > 1;
  return (
    <form action={undoSendAction} className="flex flex-col gap-2">
      {draftIds.map((id) => (
        <input key={id} type="hidden" name="draftId" value={id} />
      ))}
      <p className="font-semibold" aria-live="off">
        Sending in {left} second{left === 1 ? "" : "s"}.
      </p>
      <UndoButton label={many ? `Undo all ${draftIds.length}` : "Undo"} />
    </form>
  );
}
