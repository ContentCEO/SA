"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Check 8 P1: how long "Sending…" may sit before the owner is told why. */
export const SLOW_SEND_MS = 12_000;

/**
 * Send reply, with "Sending…" while the tap is on its way. On a weak signal that takes long,
 * a line under it says so (words only; the tap is never sent twice).
 */
export function SendButton({
  label = "Send reply",
  ...props
}: { label?: string } & React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [pending]);
  return (
    <>
      <Button type="submit" size="lg" disabled={pending} className="w-full" {...props}>
        {pending ? "Sending…" : label}
      </Button>
      {pending && slow ? (
        <p role="status" className="text-sm font-semibold">
          Still trying. Weak signal. Don&apos;t close the app.
        </p>
      ) : null}
    </>
  );
}
