"use client";

import { useActionState } from "react";
import { TimeZoneInput } from "./time-zone-input";
import { LICENSE_LABELS, type Licenses } from "@/config/licenses";
import { MAX_EXTRA_TRADES, TRADE_OPTIONS } from "@/config/trades";
import { US_STATES } from "@/config/us-states";
import { depositTermsWarning } from "@/server/deposit-rules";
import { saveBusinessProfileAction, type FormState } from "@/app/(app)/settings/profile-actions";
import { Button } from "@/components/ui/button";
import { useFocusFirstError } from "./use-focus-first-error";
import { useKeptForm } from "./use-kept-form";
import { fingerprintOf } from "@/lib/kept-text";
import { SelectField, TextArea, TextField } from "./field";

export type ProfileDefaults = {
  businessName: string | null;
  trade: string | null;
  /** Up to two more trades (round 2, TW A4). */
  extraTrades: string[];
  services: string | null;
  serviceArea: string | null;
  /** Leads package (B9): the exact towns list (pre-filled as a suggestion while empty). */
  serviceTowns: string[];
  hours: string | null;
  leadTime: string | null;
  pricingNotes: string | null;
  paymentTerms: string | null;
  policies: string | null;
  signature: string | null;
  reviewUrl: string | null;
  doNotPromise: string[];
  vipSenders: string[];
  amountThresholdDollars: number;
  /** Check 38 P6: registration and license numbers. */
  licenses: Licenses;
  /** Check 38 P2: two-letter state code, or null. */
  state: string | null;
};

const trades = TRADE_OPTIONS;
const states = US_STATES.map(([value, label]) => ({ value, label }));
const extraChoices = TRADE_OPTIONS.filter((t) => t.value !== "other");

/** Everything the server doesn't require (round 2, FW: folded away during setup). */
const OPTIONAL_FIELDS = [
  "extraTrades",
  "serviceArea",
  "serviceTowns",
  "hours",
  "leadTime",
  "pricingNotes",
  "paymentTerms",
  "policies",
  "signature",
  "reviewUrl",
  "doNotPromise",
  "vipSenders",
  "amountThresholdDollars",
  "state",
  "hicNumber",
  "hicExpiresOn",
  "cslNumber",
  "leadSafeLicense",
  "insuranceCarrier",
] as const;

export function BusinessProfileForm({
  defaults,
  returnTo,
  submitLabel,
  setup = false,
}: {
  defaults: ProfileDefaults;
  returnTo: "/settings/business?done=profile" | "/welcome/learning";
  submitLabel: string;
  /**
   * Round 2 (FW): first-time setup. The three required questions come first; the rest is folded
   * under "More details, optional" (opened if one of them needs fixing), and the browser's time
   * zone is saved with it, so 7am and quiet hours are the owner's own from day one.
   */
  setup?: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveBusinessProfileAction,
    {},
  );
  const e = state.errors ?? {};
  const formRef = useFocusFirstError(state.errors);
  // Check 8 P1: what's typed survives no signal, a failed save or a reload (this tab only).
  useKeptForm(formRef, "business-profile", fingerprintOf(JSON.stringify(defaults)));
  const v = (k: keyof ProfileDefaults, fallback: string | number | null) =>
    state.values?.[k] ?? fallback;
  const lv = (k: string, fallback: string | undefined) => state.values?.[k] ?? fallback ?? "";
  const joined = (list: string[]) => list.join("\n");
  const optionalNeedsFixing = OPTIONAL_FIELDS.some((k) => e[k]?.length);
  // Check 38 P2: a non-blocking line under "How do you get paid?" (the save still goes through).
  const depositWarning = depositTermsWarning(
    v("state", defaults.state) as string | null,
    v("paymentTerms", defaults.paymentTerms) as string | null,
  );

  const optionalFields = (
    <>
      <fieldset
        className="flex flex-col gap-1.5"
        aria-describedby={e.extraTrades ? "extraTrades-error" : "extraTrades-hint"}
      >
        <legend className="font-semibold">Do you do other trades too? (optional)</legend>
        <span id="extraTrades-hint" className="text-sm">
          Tick up to {MAX_EXTRA_TRADES}, like plumbing and heating. Drafts then know those words and
          questions too.
        </span>
        <input type="hidden" name="extraTradesShown" value="1" />
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {extraChoices.map((t) => {
            const before = state.values
              ? (state.values.extraTrades ?? "").split(",").includes(t.value)
              : defaults.extraTrades.includes(t.value);
            return (
              <label key={t.value} className="flex min-h-tap items-center gap-3">
                <input
                  type="checkbox"
                  name="extraTrades"
                  value={t.value}
                  defaultChecked={before}
                  className="size-5 shrink-0 accent-current"
                />
                <span>{t.label}</span>
              </label>
            );
          })}
        </div>
        {e.extraTrades?.length ? (
          <span id="extraTrades-error" className="font-semibold">
            {e.extraTrades[0]}
          </span>
        ) : null}
      </fieldset>
      <TextArea
        name="serviceArea"
        label="Where do you work?"
        hint="Towns or how far you'll travel."
        defaultValue={v("serviceArea", defaults.serviceArea) as string}
        error={e.serviceArea}
        rows={2}
      />
      <TextArea
        name="serviceTowns"
        label="Towns you work in (optional)"
        hint="One per line, like “Lowell, MA”. “Where do you work?” is what replies say. This list is exact: we'll point out quote requests that name a town that isn't on it. Leave it empty to skip."
        defaultValue={v("serviceTowns", joined(defaults.serviceTowns)) as string}
        error={e.serviceTowns}
        rows={3}
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
      <SelectField
        name="state"
        label="Which state do you work in?"
        hint="Some rules, like how big a deposit can be, depend on it."
        options={states}
        emptyLabel="Not set"
        defaultValue={v("state", defaults.state) as string}
        error={e.state}
      />
      <TextArea
        name="paymentTerms"
        label="How do you get paid?"
        hint="Deposits, net 30, check or card."
        defaultValue={v("paymentTerms", defaults.paymentTerms) as string}
        error={e.paymentTerms}
        rows={2}
      />
      {depositWarning ? (
        <p
          role="status"
          className="-mt-4 rounded-lg border-2 border-charcoal px-4 py-3 font-semibold"
        >
          {depositWarning}
        </p>
      ) : null}
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
      <TextField
        name="reviewUrl"
        type="url"
        label="Your review link"
        hint="Where happy customers can leave a review (Google, Yelp…). We only add it to a draft when you tap Ask for a review."
        defaultValue={v("reviewUrl", defaults.reviewUrl) as string}
        error={e.reviewUrl}
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
      <fieldset className="flex flex-col gap-6">
        <legend className="font-semibold">Licenses and registrations (optional)</legend>
        <p className="-mt-4 text-sm text-muted-foreground">
          Drafts quote only these, exactly as you type them, and never make up a number. Leave a
          line empty if it doesn&apos;t apply.
        </p>
        <TextField
          name="hicNumber"
          label={LICENSE_LABELS.hic_number}
          defaultValue={lv("hicNumber", defaults.licenses.hic_number)}
          error={e.hicNumber}
        />
        <TextField
          name="hicExpiresOn"
          type="date"
          label="HIC registration runs out on"
          hint="We'll remind you here when it's 30 days away."
          defaultValue={lv("hicExpiresOn", defaults.licenses.hic_expires_on)}
          error={e.hicExpiresOn}
        />
        <TextField
          name="cslNumber"
          label={LICENSE_LABELS.csl_number}
          defaultValue={lv("cslNumber", defaults.licenses.csl_number)}
          error={e.cslNumber}
        />
        <TextField
          name="leadSafeLicense"
          label={LICENSE_LABELS.lead_safe_license}
          defaultValue={lv("leadSafeLicense", defaults.licenses.lead_safe_license)}
          error={e.leadSafeLicense}
        />
        <TextField
          name="insuranceCarrier"
          label={LICENSE_LABELS.insurance_carrier}
          defaultValue={lv("insuranceCarrier", defaults.licenses.insurance_carrier)}
          error={e.insuranceCarrier}
        />
      </fieldset>
      <TextField
        name="amountThresholdDollars"
        label="Send me anything that mentions more than"
        hint="In dollars. Emails with bigger numbers always come to you."
        inputMode="numeric"
        defaultValue={v("amountThresholdDollars", defaults.amountThresholdDollars) as string}
        error={e.amountThresholdDollars}
      />
    </>
  );

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="returnTo" value={returnTo} />
      {setup ? <TimeZoneInput fallback="America/New_York" /> : null}
      {state.errors ? (
        <p role="alert" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
          A couple of things need fixing below.
        </p>
      ) : null}

      <TextField
        name="businessName"
        label="What's the business called? (required)"
        defaultValue={v("businessName", defaults.businessName) as string}
        error={e.businessName}
      />
      <SelectField
        name="trade"
        label="What's your trade? (required)"
        options={trades}
        defaultValue={v("trade", defaults.trade) as string}
        error={e.trade}
      />
      <TextArea
        name="services"
        label="What work do you take on? (required)"
        hint="The jobs you want more of, and the ones you don't do. “Service calls, panel upgrades, EV chargers. No new construction.”"
        defaultValue={v("services", defaults.services) as string}
        error={e.services}
      />
      {setup ? (
        <details open={optionalNeedsFixing || undefined} className="flex flex-col gap-6">
          <summary className="flex min-h-tap cursor-pointer items-center rounded-lg border-2 border-charcoal px-4 font-black">
            More details, optional
          </summary>
          <p className="py-3 text-muted-foreground">
            Your price list, hours, how you get paid and more. Each one makes the drafts better. Add
            them now or later in Settings.
          </p>
          <div className="flex flex-col gap-6">{optionalFields}</div>
        </details>
      ) : (
        optionalFields
      )}

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
