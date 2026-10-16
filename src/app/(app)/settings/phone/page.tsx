import type { Metadata } from "next";
import { GetTheApp } from "@/components/app/get-the-app";
import { AutoSaveForm } from "@/components/forms/auto-save-form";
import { Button } from "@/components/ui/button";
import { devicePrefs } from "@/lib/device-prefs";
import { requireOwner } from "@/server/session";
import { saveHandAction, saveOfflineAction } from "../device-actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "This phone" };

/** Settings kept on this phone only (cookies): the app, which hand, the offline queue. */
export default async function PhoneSettingsPage(props: PageProps<"/settings/phone">) {
  await requireOwner();
  const device = await devicePrefs();
  return (
    <SettingsScreen path="/settings/phone" heavy="this phone." params={await props.searchParams}>
      <section aria-labelledby="app-heading" className="flex flex-col gap-3">
        <h2 id="app-heading" className="text-xl font-black">
          Get the app
        </h2>
        <p className="text-muted-foreground">
          Put Squared Away on your home screen. It opens straight to your queue, full screen, with
          the same login.
        </p>
        <GetTheApp />
      </section>

      <section aria-labelledby="this-phone-heading" className="flex flex-col gap-3">
        <h2 id="this-phone-heading" className="text-xl font-black">
          On this phone
        </h2>
        <AutoSaveForm action={saveHandAction} hideButton className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="font-semibold">Which hand do you hold it in?</legend>
            {(
              [
                ["right", "Right hand"],
                ["left", "Left hand — mirror the swipes and buttons"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-tap items-center gap-3 py-1">
                <input
                  type="radio"
                  name="hand"
                  value={value}
                  defaultChecked={(value === "left") === device.leftHanded}
                  className="size-6 shrink-0"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            Right hand: swipe a draft right to open it for sending, left to discard. Left hand: the
            other way round. A swipe never sends, and a discard gives you a few seconds to undo.
          </p>
          <Button type="submit" variant="outline" className="sa-autosave-button w-full">
            Save
          </Button>
        </AutoSaveForm>
        <AutoSaveForm
          action={saveOfflineAction}
          hideButton
          className="flex flex-col gap-2 border-t pt-3"
        >
          <label className="flex min-h-tap items-start gap-3 py-2">
            <input
              type="checkbox"
              name="offline"
              value="on"
              defaultChecked={device.offline}
              className="mt-0.5 size-6 shrink-0"
            />
            <span>
              <span className="font-semibold">Keep my queue on this phone for no-signal spots</span>
              <span className="block text-sm text-muted-foreground">
                Off unless you switch it on. It keeps a copy of your waiting drafts — including what
                customers wrote — on this phone. A Send reply tapped with no signal goes once
                you&apos;re back online, only if the draft hasn&apos;t changed, and only within 12
                hours. Signing out deletes the copy. Customer notes don&apos;t show on queue cards
                on this phone while this is on.
              </span>
            </span>
          </label>
          <Button type="submit" variant="outline" className="sa-autosave-button w-full">
            Save
          </Button>
        </AutoSaveForm>
      </section>
    </SettingsScreen>
  );
}
