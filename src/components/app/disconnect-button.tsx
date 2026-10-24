"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { OUTLOOK_REMOVE_ACCESS } from "@/lib/outlook-words";

function ConfirmButton({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending
        ? "Disconnecting…"
        : name === "Outlook"
          ? "Yes, disconnect Outlook"
          : "Yes, disconnect Gmail"}
    </Button>
  );
}

/**
 * One confirmation, then immediate. Used in Settings and on the terms screen; each passes its
 * own server action.
 */
export function DisconnectButton({
  mailboxId,
  email,
  action,
  provider = "gmail",
}: {
  mailboxId: string;
  email: string;
  action: (formData: FormData) => Promise<void>;
  /** Plan #49: "outlook" only for an Outlook mailbox (FEATURE_OUTLOOK). */
  provider?: "gmail" | "outlook";
}) {
  const name = provider === "outlook" ? "Outlook" : "Gmail";
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        {provider === "outlook" ? "Disconnect Outlook" : "Disconnect Gmail"}
      </Button>
    );
  }

  return (
    <form action={action} className="sa-inverted flex flex-col gap-3 rounded-xl p-4">
      <p className="text-base">
        Disconnect <strong>{email}</strong>? Squared Away will stop reading and drafting right away
        {provider === "outlook" ? (
          <>. {OUTLOOK_REMOVE_ACCESS}</>
        ) : (
          <>, and we&apos;ll remove our access at Google.</>
        )}
      </p>
      <input type="hidden" name="mailboxId" value={mailboxId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfirmButton name={name} />
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Keep it connected
        </Button>
      </div>
    </form>
  );
}
