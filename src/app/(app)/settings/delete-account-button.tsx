"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { deleteAccountAction } from "./actions";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Deleting…" : "Yes, delete everything"}
    </Button>
  );
}

/** One confirmation that says exactly what happens, then immediate. */
export function DeleteAccountButton({ hasPlan }: { hasPlan: boolean }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Delete my account
      </Button>
    );
  }

  return (
    <form
      action={deleteAccountAction}
      aria-label="Delete my account"
      className="sa-inverted flex flex-col gap-3 rounded-xl p-4"
    >
      <p className="text-lg font-black">Delete your account and everything in it?</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {hasPlan ? <li>Your plan is canceled now — no more charges.</li> : null}
        <li>We remove our access to your Gmail at Google.</li>
        <li>
          We delete your synced email, drafts, business and voice profile, settings and history.
          This can&apos;t be undone.
        </li>
        <li>Your Gmail itself isn&apos;t touched — drafts already in Gmail stay yours.</li>
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfirmButton />
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Keep my account
        </Button>
      </div>
    </form>
  );
}
