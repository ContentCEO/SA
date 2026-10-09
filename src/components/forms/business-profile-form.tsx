"use client";

import { useActionState } from "react";
import { saveBusinessProfileAction, type FormState } from "@/app/(app)/settings/profile-actions";
import { Button } from "@/components/ui/button";
import { useFocusFirstError } from "./use-focus-first-error";
import { SelectField, TextArea, TextField } from "./field";

export type ProfileDefaults = {
  businessName: string | null;
  trade: string | null;
  services: string | null;
  serviceArea: string | null;
  hours: string | null;
  leadTime: string | null;
  pricingNotes: string | null;
  paymentTerms: string | null;
  policies: string | null;
  signature: string | null;
  doNotPromise: string[];
  vipSenders: string[];
  amountThresholdDollars: number;
};

const trades = [
  { value: "electrical", label: "Electrical" },
  { value: "plumbing", label: "Plumbing" },
  { value: "carpentry", label: "Carpentry" },
  { value: "other", label: "Something else" },
];

export function BusinessProfileForm({
  defaults,
  returnTo,
  submitLabel,
}: {
  defaults: ProfileDefaults;
  returnTo: "/settings?done=profile" | "/welcome/learning";
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveBusinessProfileAction,
    {},
  );
  const e = state.errors ?? {};
  const formRef = useFocusFirstError(state.errors);
  const v = (k: keyof ProfileDefaults, fallback: string | number | null) =>
    state.values?.[k] ?? fallback;
  const joined = (list: string[]) => list.join("\n");

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="returnTo" value={returnTo} />
      {state.errors ? (
        <p role="alert" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
          A couple of things need fixing below.
        </p>
      ) : null}

      <TextField
        name="businessName"
        label="What's the business called?"
        defaultValue={v("businessName", defaults.businessName) as string}
        error={e.businessName}
      />
      <SelectField
        name="trade"
        label="What's your trade?"
        options={trades}
        defaultValue={v("trade", defaults.trade) as string}
        error={e.trade}
      />
      <TextArea
        name="services"
        label="What work do you take on?"
        hint="The jobs you want more of, and the ones you don't do. “Service calls, panel upgrades, EV chargers. No new construction.”"
        defaultValue={v("services", defaults.services) as string}
        error={e.services}
      />
      <TextArea
        name="serviceArea"
        label="Where do you work?"
        hint="Towns or how far you'll travel."
        defaultValue={v("serviceArea", defaults.serviceArea) as string}
        error={e.serviceArea}
        rows={2}
      />
      <TextArea
        name="hours"
        label="When are you working?"
        hint="“Mon–Fri 7–4, emergencies on weekends.”"
        defaultValue={v("hours", defaults.hours) as string}
        error={e.hours}
        rows={2}
      />
      <TextArea
        name="leadTime"
        label="How far out are you booking right now?"
        hint="Drafts won't promise a date — they'll use this to set expectations."
        defaultValue={v("leadTime", defaults.leadTime) as string}
        error={e.leadTime}
        rows={2}
      />
      <TextArea
        name="pricingNotes"
        label="Your price list"
        hint="One per line — only prices you're happy to put in writing. Drafts quote these exactly as written and never make up others. e.g. “Service call: $95, first half hour included” · “Water heater swap (40 gal tank): from $1,450 installed”"
        defaultValue={v("pricingNotes", defaults.pricingNotes) as string}
        error={e.pricingNotes}
      />
      <TextArea
        name="paymentTerms"
        label="How do you get paid?"
        hint="Deposits, net 30, check or card."
        defaultValue={v("paymentTerms", defaults.paymentTerms) as string}
        error={e.paymentTerms}
        rows={2}
      />
      <TextArea
        name="policies"
        label="Anything customers should know?"
        hint="Permits, warranty, cancellations, cleanup."
        defaultValue={v("policies", defaults.policies) as string}
        error={e.policies}
      />
      <TextArea
        name="signature"
        label="How do you sign your emails?"
        hint="Exactly as you'd type it."
        defaultValue={v("signature", defaults.signature) as string}
        error={e.signature}
        rows={3}
      />
      <TextArea
        name="doNotPromise"
        label="Things we should never promise"
        hint="One per line. Drafts will never say these. “Same-day service”, “A price over email”, “Weekend work”."
        defaultValue={v("doNotPromise", joined(defaults.doNotPromise)) as string}
        error={e.doNotPromise}
        rows={4}
      />
      <TextArea
        name="vipSenders"
        label="People who always need you"
        hint="One email address per line — your biggest GC, your bookkeeper. Their emails always come straight to you."
        defaultValue={v("vipSenders", joined(defaults.vipSenders)) as string}
        error={e.vipSenders}
        rows={3}
      />
      <TextField
        name="amountThresholdDollars"
        label="Send me anything that mentions more than"
        hint="In dollars. Emails with bigger numbers always come to you."
        inputMode="numeric"
        defaultValue={v("amountThresholdDollars", defaults.amountThresholdDollars) as string}
        error={e.amountThresholdDollars}
      />

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
