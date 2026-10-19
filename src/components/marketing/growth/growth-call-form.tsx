"use client";

import { Check } from "lucide-react";
import { useActionState, useLayoutEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { requestGrowthCallAction, type GrowthState } from "@/app/growth-actions";
import { SelectField, TextArea, TextField } from "@/components/forms/field";
import { TimeZoneInput } from "@/components/forms/time-zone-input";
import { FormError } from "@/components/forms/form-error";
import { useFocusFirstError } from "@/components/forms/use-focus-first-error";
import { ReferralField } from "@/components/marketing/referral-field";
import { SourceFields } from "@/components/marketing/source-fields";
import { Button } from "@/components/ui/button";
import { GROWTH_HEARD_FROM, GROWTH_REQUEST_OPTIONS } from "@/config/growth";
import { siteConfig } from "@/config/site";
import { TRADE_OPTIONS } from "@/config/trades";
import { US_STATES } from "@/config/us-states";
import { phoneHref } from "@/lib/phone-href";
import { growthCopy } from "./growth-copy";

const c = growthCopy.form;
const trades = TRADE_OPTIONS.map((t) => (t.value === "other" ? { ...t, label: c.otherTrade } : t));
const states = US_STATES.map(([value, label]) => ({ value, label }));

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? c.pending : c.submit}
    </Button>
  );
}

function Success({ phone }: { phone?: string }) {
  const s = growthCopy.success;
  const ref = useRef<HTMLDivElement>(null);
  // The thank-you is much shorter than the form it replaces: bring it into view (clear of the
  // sticky bar) and move focus there, since the button that had focus is gone.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    window.dispatchEvent(new Event("sa:hold-switch"));
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} role="status" tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <p className="flex flex-col">
        <span className="sa-headline-serif text-3xl">{s.serif}</span>{" "}
        <span className="sa-headline-heavy text-4xl">{s.heavy}</span>
      </p>
      <p className="text-xl font-black">
        {phone ? (
          <>
            {s.withPhoneBefore}
            <span className="whitespace-nowrap">{phone}</span>
            {s.withPhoneAfter}
          </>
        ) : (
          s.noPhone
        )}
      </p>
      <p className="text-slate">
        {s.soonerBefore}
        <a
          href={phoneHref("tel", siteConfig.phone)}
          className="inline-flex min-h-tap items-center font-semibold text-charcoal underline underline-offset-4"
        >
          {siteConfig.phone}
        </a>
        {s.soonerAfter}
      </p>
      <p className="text-slate">{s.done}</p>
    </div>
  );
}

/**
 * The call-request form for Squared Away Growth. Lives in an off-white `.sa-light` card.
 * `referrals`: referral links are switched on (the server page decides); the code itself (?ref=)
 * is read in the browser so the homepage can be prerendered (Check 29 P3).
 */
export function GrowthCallForm({ referrals = false }: { referrals?: boolean } = {}) {
  const [state, action] = useActionState<GrowthState, FormData>(requestGrowthCallAction, {
    status: "idle",
  });
  const ref = useFocusFirstError(state.errors);
  // Check 5 P2: "Who sent you?" shows only with "Another contractor told me".
  const [heardFrom, setHeardFrom] = useState(state.values?.heardFrom ?? "");

  if (state.status === "requested") return <Success phone={state.phone} />;

  const v = state.values ?? {};
  const e = state.errors ?? {};
  const servicesError = e.services?.length ? e.services : undefined;
  return (
    <form ref={ref} action={action} noValidate className="flex flex-col gap-4">
      <TextField
        name="name"
        idBase="growth-name"
        label={c.name}
        autoComplete="name"
        required
        defaultValue={v.name}
        error={e.name}
      />
      <TextField
        name="phone"
        idBase="growth-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required
        label={c.phone}
        hint={c.phoneHint}
        defaultValue={v.phone}
        error={e.phone}
      />
      <TextField
        name="email"
        idBase="growth-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        label={c.email}
        hint={c.emailHint}
        defaultValue={v.email}
        error={e.email}
      />
      <SelectField
        name="trade"
        idBase="growth-trade"
        label={c.trade}
        options={trades}
        required
        defaultValue={v.trade}
        error={e.trade}
      />
      <SelectField
        name="state"
        idBase="growth-state"
        label={c.state}
        emptyLabel={c.stateEmpty}
        options={states}
        defaultValue={v.state}
        error={e.state}
      />
      <div
        className="flex flex-col gap-4"
        onChange={(ev) => {
          const t = ev.target as unknown as HTMLSelectElement;
          if (t.name === "heardFrom") setHeardFrom(t.value);
        }}
      >
        <SelectField
          name="heardFrom"
          idBase="growth-heard"
          label={c.heardFrom}
          emptyLabel={c.heardFromEmpty}
          options={GROWTH_HEARD_FROM}
          defaultValue={v.heardFrom}
          error={e.heardFrom}
        />
        {heardFrom === "contractor" ? (
          <TextField
            name="sentBy"
            idBase="growth-sent-by"
            label={c.sentBy}
            defaultValue={v.sentBy}
            error={e.sentBy}
          />
        ) : null}
      </div>
      <TimeZoneInput fallback="" />
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={
          servicesError ? "growth-services-hint growth-services-error" : "growth-services-hint"
        }
      >
        <legend className="font-semibold">{c.servicesLegend}</legend>
        <p id="growth-services-hint" className="text-slate">
          {c.servicesHint}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {GROWTH_REQUEST_OPTIONS.map((s, i) => (
            <label
              key={s.value}
              className="relative flex min-h-tap items-center gap-3 rounded-lg border-2 border-charcoal px-3 py-2 font-semibold has-checked:bg-charcoal has-checked:text-offwhite has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
            >
              {/* Invisible, over the whole row including its border: a 44px tap target. */}
              <input
                type="checkbox"
                name="services"
                value={s.value}
                defaultChecked={state.services?.includes(s.value)}
                className="peer absolute -top-0.5 -left-0.5 h-[calc(100%+4px)] w-[calc(100%+4px)] cursor-pointer opacity-0"
                aria-invalid={i === 0 && servicesError ? true : undefined}
              />
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded border-2 border-current peer-checked:[&>svg]:opacity-100"
              >
                <Check className="size-4 opacity-0" />
              </span>
              {s.label}
            </label>
          ))}
        </div>
        {servicesError ? (
          <p id="growth-services-error" role="alert" className="font-semibold">
            {servicesError[0]}
          </p>
        ) : null}
      </fieldset>
      <TextArea
        name="note"
        idBase="growth-note"
        label={c.note}
        hint={c.noteHint}
        defaultValue={v.note}
        error={e.note}
        rows={3}
      />
      {/* Left empty by people; bots fill it in. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          {c.honeypot}
          <input name="sa_hp" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {referrals ? <ReferralField kept={v.ref} /> : null}
      <SourceFields />
      <FormError errors={e.form} />
      <Submit />
      <p className="text-sm text-slate">{c.privacy}</p>
    </form>
  );
}
