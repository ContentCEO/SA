"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import { PendingButton } from "@/components/app/pending-button";
import { AGREE_FIELD, AGREE_VALUE } from "@/config/legal";
import type { AgreeState } from "@/server/terms-rules";

/**
 * The "I agree" box and its button (Davi, 2026-10-15), for sign-in and /welcome/terms. The box
 * starts unticked and the server refuses the button without it (the action checks, not only the
 * browser): the plain error shows under the box and focus moves to the box, which matters on a
 * phone where the message could be off-screen.
 */
export function TermsForm({
  action,
  submitLabel,
  pendingLabel,
  next,
}: {
  action: (state: AgreeState, formData: FormData) => Promise<AgreeState>;
  submitLabel: string;
  pendingLabel: string;
  /** /welcome/terms only: where to go afterwards (the server checks it again). */
  next?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const box = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!state.error) return;
    box.current?.focus();
    box.current?.scrollIntoView({ block: "center" });
  }, [state]);
  const errorId = `${id}-error`;
  const link = "font-semibold underline underline-offset-4";
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
      <div className="flex flex-col gap-2">
        {/* The whole row is the label: a 44px tap target that ticks the box (the links still open). */}
        <label className="flex min-h-tap items-center gap-3 text-base">
          <input
            ref={box}
            type="checkbox"
            name={AGREE_FIELD}
            value={AGREE_VALUE}
            className="size-6 shrink-0 accent-charcoal"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? errorId : undefined}
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" className={link}>
              Terms of Service
            </Link>{" "}
            and the{" "}
            <Link href="/privacy" className={link}>
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {state.error ? (
          <p id={errorId} role="alert" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
            {state.error}
          </p>
        ) : null}
      </div>
      <PendingButton pending={pendingLabel} className="w-full sm:w-auto">
        {submitLabel}
      </PendingButton>
    </form>
  );
}
