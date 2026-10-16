"use client";

import { useState } from "react";
import { PendingButton } from "@/components/app/pending-button";
import { Button } from "@/components/ui/button";

/**
 * A button that opens an inline confirmation in its place (plan #47 Keep / Go back). The
 * confirmation names exactly what happens and, for a price, the price; only "Yes, …" submits.
 */
export function ConfirmChange({
  button,
  title,
  body,
  yes,
  no,
  fields,
  action,
}: {
  button: string;
  title: string;
  body: string[];
  yes: string;
  no: string;
  fields: Record<string, string>;
  action: (formData: FormData) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button type="button" className="w-full" onClick={() => setConfirming(true)}>
        {button}
      </Button>
    );
  }

  return (
    <form
      action={action}
      aria-label={title}
      className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="text-lg font-black">{title}</p>
      {body.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <div className="flex flex-col gap-2">
        <PendingButton pending="Working…" className="w-full">
          {yes}
        </PendingButton>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => setConfirming(false)}
        >
          {no}
        </Button>
      </div>
    </form>
  );
}
