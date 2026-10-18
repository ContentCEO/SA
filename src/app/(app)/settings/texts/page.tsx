import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { smsConfigured } from "@/lib/sms";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { formatUsPhone, textsStep } from "@/server/sms-alerts";
import { zoneTimeName } from "@/server/time-zone-rules";
import { EmergencySwitch } from "../emergency-switch";
import { SettingsScreen } from "../screen";
import {
  confirmSmsCodeAction,
  removeSmsPhoneAction,
  sendSmsCodeAction,
  toggleSmsAlertsAction,
} from "../sms-actions";

export const metadata: Metadata = { title: "Text alerts" };

/** Hidden (back to the list) until texting is switched on, rather than described as on its way. */
export default async function TextAlertSettingsPage(props: PageProps<"/settings/texts">) {
  const { workspace } = await requireOwner();
  if (!smsConfigured()) redirect("/settings");
  const profile = await getBusinessProfile(workspace.id);
  const step = textsStep(profile ?? null, new Date());
  return (
    <SettingsScreen path="/settings/texts" heavy="text alerts." params={await props.searchParams}>
      <p className="text-muted-foreground">
        A text when a new quote request or an email that needs you comes in. Just the count and a
        link — never a customer&apos;s name or words. Not between 9pm and 7am{" "}
        {zoneTimeName(profile?.timeZone)} (except emergencies, if you leave that on below), at most
        one every 10 minutes. Reply STOP any time.
      </p>
      {profile && step === "confirmed" ? (
        <div className="flex flex-col gap-3">
          <p>
            Texts go to <span className="font-semibold">{formatUsPhone(profile.alertPhone!)}</span>.
          </p>
          <form action={toggleSmsAlertsAction}>
            <input type="hidden" name="enabled" value={profile.smsAlertsEnabled ? "off" : "on"} />
            <Button type="submit" variant="outline" className="w-full">
              {profile.smsAlertsEnabled ? "Turn off text alerts" : "Turn on text alerts"}
            </Button>
          </form>
          <form action={removeSmsPhoneAction}>
            <Button type="submit" variant="ghost" className="w-full">
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
            Text me a code
          </Button>
        </form>
      )}
    </SettingsScreen>
  );
}
