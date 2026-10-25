import type { Metadata } from "next";
import { AppEmailsGoTo } from "@/components/app/app-emails-go-to";
import { AutoSaveForm } from "@/components/forms/auto-save-form";
import { Button } from "@/components/ui/button";
import { listMailboxes } from "@/server/mailboxes";
import { DIGEST_HOURS, getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { nowLine, zoneChoices, zoneLine } from "@/server/time-zone-rules";
import { usableTimeZone } from "@/server/snooze-rules";
import { trialEmailsMatter } from "@/server/trial-emails";
import { PhoneZoneOffer } from "./phone-zone-offer";
import { saveDigestSettingsAction, saveTrialEmailsAction } from "../profile-actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Morning email" };

export default async function MorningEmailSettingsPage(
  props: PageProps<"/settings/morning-email">,
) {
  const { workspace, session } = await requireOwner();
  const [profile, mailboxes] = await Promise.all([
    getBusinessProfile(workspace.id),
    listMailboxes(workspace.id),
  ]);
  const zone = usableTimeZone(profile?.timeZone);
  return (
    <SettingsScreen
      path="/settings/morning-email"
      heavy="morning email."
      params={await props.searchParams}
    >
      <AutoSaveForm action={saveDigestSettingsAction} className="flex flex-col gap-3">
        <label className="flex min-h-tap items-center gap-3">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={profile?.digestEnabled ?? true}
            aria-describedby="digest-monthly-note"
            className="size-6 shrink-0"
          />
          <span className="font-semibold">Email me a summary each morning</span>
        </label>
        <p id="digest-monthly-note" className="-mt-2 pl-9 text-muted-foreground">
          (and a short one on the 1st of each month)
        </p>
        {/* Check 42 P6: where it goes — the sign-in address, from the session (never logged). */}
        <AppEmailsGoTo
          kind="digest"
          signInEmail={session.user.email}
          connectedEmails={mailboxes.map((m) => m.email)}
          className="-mt-1 pl-9 text-muted-foreground"
        />
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Send it at</span>
          <select
            name="hour"
            defaultValue={String(profile?.digestHour ?? 7)}
            className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
          >
            {DIGEST_HOURS.map((h) => (
              <option key={h} value={h}>
                {h}:00 am
              </option>
            ))}
          </select>
        </label>
        {/* Check 44 P5 / 15 P7: the zone is shown and picked here; no hidden browser zone. */}
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Your time zone</span>
          <select
            name="timeZone"
            defaultValue={zone}
            aria-describedby="zone-line"
            className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
          >
            {zoneChoices(zone).map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
        {/* What the select showed: an untouched select never becomes the owner's pick. */}
        <input type="hidden" name="timeZoneShown" value={zone} />
        <p id="zone-line" className="text-muted-foreground">
          {zoneLine(zone)} {nowLine(new Date(), zone)}
        </p>
        <p className="text-muted-foreground">
          Just counts and totals — how many replies are waiting, what needs you, and this
          month&apos;s money so far (quotes won, invoices paid, still owed). No customer names or
          email text go in it. Skipped on mornings with nothing to say.
        </p>
        <Button type="submit" variant="outline" className="w-full">
          Save
        </Button>
      </AutoSaveForm>
      <PhoneZoneOffer saved={zone} />
      {trialEmailsMatter(workspace) ? (
        // 2026-10-16: the trial's short emails (day 2, the last day, and one a week after it ends).
        <AutoSaveForm action={saveTrialEmailsAction} hideButton className="flex flex-col gap-2">
          <label className="flex min-h-tap items-center gap-3">
            <input
              type="checkbox"
              name="trialEmails"
              value="on"
              defaultChecked={!workspace.trialEmailsStoppedAt}
              aria-describedby="trial-emails-note"
              className="size-6 shrink-0"
            />
            <span className="font-semibold">Trial emails</span>
          </label>
          <p id="trial-emails-note" className="-mt-1 pl-9 text-muted-foreground">
            A short one on day 2 and on your last day, and one a week after your trial ends. Counts
            only. The &ldquo;Stop these emails&rdquo; link in them switches this off too.
          </p>
          <Button type="submit" variant="outline" className="sa-autosave-button w-full">
            Save
          </Button>
        </AutoSaveForm>
      ) : null}
    </SettingsScreen>
  );
}
