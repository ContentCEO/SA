"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { useFocusFirstError } from "@/components/forms/use-focus-first-error";
import { addSeasonalNoteFormAction, type NoteFormState } from "../wording-actions";

/**
 * Check 15 P9: "Add note" keeps what was typed when it can't be saved, says why under the box
 * that needs fixing, and puts the cursor there.
 */
export function SeasonalNoteForm({ today, maxChars }: { today: string; maxChars: number }) {
  const [state, action, pending] = useActionState<NoteFormState, FormData>(
    addSeasonalNoteFormAction,
    {},
  );
  const e = state.errors ?? {};
  const formRef = useFocusFirstError(state.errors);
  const field = "min-h-tap rounded-lg border border-input bg-paper px-3 text-base";
  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3" noValidate>
      {e.form ? (
        <p role="alert" data-form-error tabIndex={-1} className="font-semibold">
          {e.form[0]}
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Note</span>
        <input
          // Remount with what was typed after a failed save.
          key={`text:${state.values?.text ?? ""}`}
          name="text"
          maxLength={maxChars}
          placeholder="Booked through November"
          defaultValue={state.values?.text ?? ""}
          aria-invalid={e.text ? true : undefined}
          aria-describedby={e.text ? "note-text-error" : undefined}
          className={field}
        />
        {e.text ? (
          <span id="note-text-error" className="font-semibold">
            {e.text[0]}
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Last day it applies</span>
        <input
          key={`endsOn:${state.values?.endsOn ?? ""}`}
          name="endsOn"
          type="date"
          min={today}
          defaultValue={state.values?.endsOn ?? ""}
          aria-invalid={e.endsOn ? true : undefined}
          aria-describedby={e.endsOn ? "note-ends-error" : undefined}
          className={field}
        />
        {e.endsOn ? (
          <span id="note-ends-error" className="font-semibold">
            {e.endsOn[0]}
          </span>
        ) : null}
      </label>
      <Button type="submit" variant="outline" disabled={pending} className="w-full">
        {pending ? "Adding…" : "Add note"}
      </Button>
    </form>
  );
}
