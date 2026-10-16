import type { Metadata } from "next";
import { AutoSaveForm } from "@/components/forms/auto-save-form";
import { Button } from "@/components/ui/button";
import { FOLLOWUP_DAY_CHOICES, getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { saveFollowupSettingsAction } from "../profile-actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Follow-ups" };

export default async function FollowupSettingsPage(props: PageProps<"/settings/follow-ups">) {
  const { workspace } = await requireOwner();
  const profile = await getBusinessProfile(workspace.id);
  return (
    <SettingsScreen
      path="/settings/follow-ups"
      heavy="follow-ups."
      params={await props.searchParams}
    >
      <AutoSaveForm action={saveFollowupSettingsAction} className="flex flex-col gap-3">
        <label className="flex min-h-tap items-center gap-3">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={profile?.followupsEnabled ?? true}
            className="size-6 shrink-0"
          />
          <span className="font-semibold">Nudge quotes and invoices that go quiet</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Wait this long for a reply</span>
          <select
            name="days"
            defaultValue={String(profile?.followupDays ?? 3)}
            className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
          >
            {FOLLOWUP_DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <p className="text-muted-foreground">
          A nudge is a draft in your queue, like any other reply — nothing sends without you. Never
          more than two per conversation, and never for complaints.
        </p>
        <Button type="submit" variant="outline" className="w-full">
          Save
        </Button>
      </AutoSaveForm>
    </SettingsScreen>
  );
}
