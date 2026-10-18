"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Check 9 P9: the words while the model writes. */
export const DRAFTING_BUSY = "Writing a draft…";
export const DRAFTING_NOTE = "This takes a few seconds. Nothing is sent.";

/**
 * "Draft a reply", with a working state: disabled while the draft is being written (a second
 * tap can't start a second run; the server also refuses one), and a line saying nothing sends.
 */
export function DraftReplyButton({ label = "Draft a reply" }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
        {pending ? DRAFTING_BUSY : label}
      </Button>
      {pending ? (
        <p role="status" className="text-sm font-semibold">
          {DRAFTING_NOTE}
        </p>
      ) : null}
    </>
  );
}
