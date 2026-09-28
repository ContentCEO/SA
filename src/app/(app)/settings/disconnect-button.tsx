"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { disconnectMailboxAction } from "./actions";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Disconnecting…" : "Yes, disconnect Gmail"}
    </Button>
  );
}

/** One confirmation, then immediate. */
export function DisconnectButton({ mailboxId, email }: { mailboxId: string; email: string }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Disconnect Gmail
      </Button>
    );
  }

  return (
    <form
      action={disconnectMailboxAction}
      className="sa-inverted flex flex-col gap-3 rounded-xl p-4"
    >
      <p className="text-base">
        Disconnect <strong>{email}</strong>? Squared Away will stop reading and drafting right away,
        and we&apos;ll remove our access at Google.
      </p>
      <input type="hidden" name="mailboxId" value={mailboxId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfirmButton />
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Keep it connected
        </Button>
      </div>
    </form>
  );
}
