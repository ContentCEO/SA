"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { deleteConfirmed } from "@/server/account-deletion-rules";

function ConfirmButton({ ready }: { ready: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || !ready}>
      {pending ? "Deleting…" : "Yes, delete everything"}
    </Button>
  );
}

/**
 * One confirmation that says exactly what happens, then immediate. Used in Settings and on the
 * terms screen (someone who won't agree to new terms can still leave): each passes its own
 * server action.
 */
export function DeleteAccountButton({
  hasPlan,
  action,
}: {
  hasPlan: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const fieldId = useId();

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Delete my account
      </Button>
    );
  }

  return (
    <form
      action={action}
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
      {/* Check 26 P4: the server checks the word too (and a fresh sign-in); this only keeps the
          button off until it's typed. */}
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="font-semibold">
          Type DELETE to confirm
        </label>
        <input
          id={fieldId}
          name="confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-tap w-full rounded-lg border-2 border-paper bg-paper px-3 text-lg text-charcoal"
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfirmButton ready={deleteConfirmed(typed)} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setConfirming(false);
            setTyped("");
          }}
        >
          Keep my account
        </Button>
      </div>
    </form>
  );
}
