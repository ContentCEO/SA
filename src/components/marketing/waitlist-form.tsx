"use client";

import { useActionState, useLayoutEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { joinWaitlistAction, type WaitlistState } from "@/app/waitlist-actions";
import { SelectField, TextArea, TextField } from "@/components/forms/field";
import { FormError } from "@/components/forms/form-error";
import { useFocusFirstError } from "@/components/forms/use-focus-first-error";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { TRADE_OPTIONS } from "@/config/trades";
import { ReferralField } from "@/components/marketing/referral-field";
import { SourceFields } from "./source-fields";
import { OtherTradeField } from "@/components/forms/other-trade-field";

const trades = TRADE_OPTIONS.map((t) =>
  t.value === "other" ? { ...t, label: "Another trade" } : t,
);
const sizes = ["Just me", "2–5", "6–15", "16+"].map((s) => ({ value: s, label: s }));

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Adding you…" : "Join the waitlist"}
    </Button>
  );
}

function Joined() {
  const ref = useRef<HTMLDivElement>(null);
  // The thank-you is far shorter than the form it replaces: bring it into view (clear of the
  // sticky header) and move focus there, since the button that had focus is gone. The homepage
  // switch is told first, so the page shrinking under a still screen never plays the Growth show.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    window.dispatchEvent(new Event("sa:hold-switch"));
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      role="status"
      tabIndex={-1}
      className="sa-inverted flex flex-col gap-3 rounded-2xl p-6 outline-none"
    >
      <p className="flex flex-col">
        <span className="sa-headline-serif text-3xl">thanks,</span>{" "}
        <span className="sa-headline-heavy text-4xl">squared away.</span>
      </p>
      <p className="text-xl font-black">
        You&apos;re on the list. {siteConfig.operator.split(" ")[0]} will be in touch.
      </p>
      <p className="text-ash">
        We set each shop up by hand, so we&apos;ll call or email you to arrange a time. Nothing else
        to do for now.
      </p>
    </div>
  );
}

/** `referrals`: referral links are switched on (decided by the server page). */
export function WaitlistForm({ referrals = false }: { referrals?: boolean } = {}) {
  const [state, action] = useActionState<WaitlistState, FormData>(joinWaitlistAction, {
    status: "idle",
  });
  const ref = useFocusFirstError(state.errors);

  if (state.status === "joined") return <Joined />;

  const v = state.values ?? {};
  const e = state.errors ?? {};
  return (
    <form ref={ref} action={action} className="flex flex-col gap-4" noValidate>
      <TextField
        name="name"
        label="Your name"
        autoComplete="name"
        required
        defaultValue={v.name}
        error={e.name}
      />
      <TextField
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        label="Business email"
        hint="Gmail, or your own business address if it runs on Google. On Outlook? Join anyway, it's on the list."
        defaultValue={v.email}
        error={e.email}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="trade"
          label="Trade"
          options={trades}
          required
          defaultValue={v.trade}
          error={e.trade}
        />
        <SelectField
          name="teamSize"
          label="People in the business"
          options={sizes}
          required
          defaultValue={v.teamSize}
          error={e.teamSize}
        />
      </div>
      {/* Check 41 P4: say which trade "Another trade" is. */}
      <OtherTradeField initialTrade={v.trade} defaultValue={v.tradeOther} error={e.tradeOther} />
      <TextField
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
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
      {referrals ? <ReferralField kept={v.ref} /> : null}
      {/* Left empty by people; bots fill it in. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SourceFields />
      <FormError errors={e.form} />
      <Submit />
      <p className="text-sm text-muted-foreground">
        We only use this to get in touch about Squared Away. No newsletters.
      </p>
    </form>
  );
}
