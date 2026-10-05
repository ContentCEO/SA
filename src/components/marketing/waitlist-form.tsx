"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { joinWaitlistAction, type WaitlistState } from "@/app/waitlist-actions";
import { SelectField, TextArea, TextField } from "@/components/forms/field";
import { useFocusFirstError } from "@/components/forms/use-focus-first-error";
import { Button } from "@/components/ui/button";

const trades = [
  { value: "carpentry", label: "Carpentry" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "other", label: "Another trade" },
];
const sizes = ["Just me", "2–5", "6–15", "16+"].map((s) => ({ value: s, label: s }));

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Adding you…" : "Join the waitlist"}
    </Button>
  );
}

export function WaitlistForm() {
  const [state, action] = useActionState<WaitlistState, FormData>(joinWaitlistAction, {
    status: "idle",
  });
  const ref = useFocusFirstError(state.errors);

  if (state.status === "joined") {
    return (
      <div role="status" className="sa-inverted flex flex-col gap-3 rounded-2xl p-6">
        <p className="flex flex-col">
          <span className="sa-headline-serif text-3xl">you&apos;re on the list,</span>
          <span className="sa-headline-heavy text-4xl">squared away.</span>
        </p>
        <p className="text-ash">
          We set each shop up by hand, so we&apos;ll call or email you to arrange a time. Nothing
          else to do for now.
        </p>
      </div>
    );
  }

  const v = state.values ?? {};
  const e = state.errors ?? {};
  return (
    <form ref={ref} action={action} className="flex flex-col gap-4" noValidate>
      <TextField name="name" label="Your name" defaultValue={v.name} error={e.name} />
      <TextField
        name="email"
        type="email"
        inputMode="email"
        label="Business Gmail"
        hint="The Gmail address your customers write to."
        defaultValue={v.email}
        error={e.email}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="trade"
          label="Trade"
          options={trades}
          defaultValue={v.trade}
          error={e.trade}
        />
        <SelectField
          name="teamSize"
          label="People in the business"
          options={sizes}
          defaultValue={v.teamSize}
          error={e.teamSize}
        />
      </div>
      <TextField
        name="phone"
        type="tel"
        label="Phone (optional)"
        hint="If you'd rather we call."
        defaultValue={v.phone}
        error={e.phone}
      />
      <TextArea
        name="note"
        label="Anything we should know? (optional)"
        defaultValue={v.note}
        error={e.note}
        rows={3}
      />
      {/* Left empty by people; bots fill it in. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <Submit />
      <p className="text-sm text-muted-foreground">
        We only use this to get in touch about Squared Away. No newsletters.
      </p>
    </form>
  );
}
