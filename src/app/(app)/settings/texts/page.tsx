import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { smsConfigured } from "@/lib/sms";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import Link from "next/link";
import { formatUsPhone, SMS, textsStep } from "@/server/sms-alerts";
import { zoneTimeName } from "@/server/time-zone-rules";
import { lastSmsDelivery } from "@/server/sms-deliveries";
import { lastTextLine, textsConsentCopy } from "@/server/sms-delivery-rules";
import { usableTimeZone } from "@/server/snooze-rules";
import { extraTextsCopy } from "@/server/sms-summary-rules";
import { LEAD_AT_RISK_HOURS, LEAD_AT_RISK_PUSHES_PER_DAY } from "@/config/business-hours";
import { EmergencySwitch } from "../emergency-switch";
import { SettingsScreen } from "../screen";
import {
  confirmSmsCodeAction,
  removeSmsPhoneAction,
  sendSmsCodeAction,
  toggleExtraTextAction,
  toggleSmsAlertsAction,
} from "../sms-actions";

export const metadata: Metadata = { title: "Text alerts" };

/** Hidden (back to the list) until texting is switched on, rather than described as on its way. */
export default async function TextAlertSettingsPage(props: PageProps<"/settings/texts">) {
  const { workspace } = await requireOwner();
  if (!smsConfigured()) redirect("/settings");
  const profile = await getBusinessProfile(workspace.id);
  const now = new Date();
  const step = textsStep(profile ?? null, now);
  // Check 19 P6: what Twilio said about the last text, in plain words (never claimed before
  // Twilio reports it delivered).
  const lastLine =
    step === "phone"
      ? null
      : lastTextLine({
          stoppedReason: profile?.smsStoppedReason,
          last: await lastSmsDelivery(workspace.id),
          timeZone: usableTimeZone(profile?.timeZone),
          now,
        });
  // Check 27 P6: the carrier-required words, with the numbers from the SMS limits in code.
  const copy = textsConsentCopy(SMS, zoneTimeName(profile?.timeZone));
  // Plan #50: the two extra texts' words, with the numbers from the limits in code.
  const extra = extraTextsCopy({
    ...SMS,
    atRiskHours: LEAD_AT_RISK_HOURS,
    atRiskPerDay: LEAD_AT_RISK_PUSHES_PER_DAY,
    digestHour: profile?.digestHour ?? 7,
  });
  const extras = profile
    ? ([
        { which: "summary", on: profile.smsSummaryEnabled, words: extra.summary },
        { which: "at_risk", on: profile.smsAtRiskEnabled, words: extra.atRisk },
      ] as const)
    : [];
  return (
    <SettingsScreen path="/settings/texts" heavy="text alerts." params={await props.searchParams}>
      <p className="text-muted-foreground">{copy.intro}</p>
      {lastLine ? (
        <p role="status" className="font-semibold">
          {lastLine}
        </p>
      ) : null}
      {profile && step === "confirmed" ? (
        <div className="flex flex-col gap-3">
          <p>
            Texts go to <span className="font-semibold">{formatUsPhone(profile.alertPhone!)}</span>.
          </p>
          <form action={toggleSmsAlertsAction}>
            <input type="hidden" name="enabled" value={profile.smsAlertsEnabled ? "off" : "on"} />
            <Button
              type="submit"
              variant="outline"
              className="w-full"
              data-refocus="sms-alerts-toggle"
            >
              {profile.smsAlertsEnabled ? "Turn off text alerts" : "Turn on text alerts"}
            </Button>
          </form>
          {profile.smsAlertsEnabled
            ? extras.map((x) => (
                <form
                  key={x.which}
                  action={toggleExtraTextAction}
                  className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
                >
                  <input type="hidden" name="which" value={x.which} />
                  <input type="hidden" name="enabled" value={x.on ? "off" : "on"} />
                  <p className="font-semibold">
                    {x.words.title}: {x.on ? "on" : "off"}
                  </p>
                  <p className="text-muted-foreground">{x.words.what}</p>
                  <p className="text-sm text-muted-foreground">{x.words.cap}</p>
                  <Button
                    type="submit"
                    variant="outline"
                    className="w-full"
                    data-refocus={`sms-${x.which}-toggle`}
                  >
                    {x.on ? x.words.off : x.words.on}
                  </Button>
                </form>
              ))
            : null}
          <form action={removeSmsPhoneAction}>
            <Button type="submit" variant="outline" className="w-full">
              Remove my number
            </Button>
          </form>
          <EmergencySwitch enabled={profile.emergencyAlertsEnabled} from="texts" />
        </div>
      ) : profile && step === "code" ? (
        <form action={confirmSmsCodeAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">
              The 6-digit code we texted to {formatUsPhone(profile.alertPhone!)}
            </span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-lg tracking-widest"
            />
          </label>
          <Button type="submit" className="w-full">
            Confirm my number
          </Button>
        </form>
      ) : (
        <form action={sendSmsCodeAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Your mobile number</span>
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="(508) 555-1234"
              required
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            />
          </label>
          <Button type="submit" className="w-full">
            {copy.button}
          </Button>
          <p className="text-sm text-muted-foreground">
            {copy.consent}{" "}
            <Link
              href="/terms"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Terms
            </Link>{" "}
            {copy.consentEnd}{" "}
            <Link
              href="/privacy"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </form>
      )}
    </SettingsScreen>
  );
}
