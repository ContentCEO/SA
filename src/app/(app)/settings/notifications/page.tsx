import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PushToggle } from "@/components/app/push-toggle";
import { vapidPublicKey } from "@/lib/web-push";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { EmergencySwitch } from "../emergency-switch";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Notifications" };

/** Plan #36. Hidden (back to the list) until phone notifications are set up. */
export default async function NotificationSettingsPage(
  props: PageProps<"/settings/notifications">,
) {
  const { workspace } = await requireOwner();
  const key = vapidPublicKey();
  if (!key) redirect("/settings");
  const profile = await getBusinessProfile(workspace.id);
  return (
    <SettingsScreen
      path="/settings/notifications"
      heavy="notifications."
      params={await props.searchParams}
    >
      <PushToggle publicKey={key} />
      <EmergencySwitch enabled={profile?.emergencyAlertsEnabled ?? true} from="notifications" />
    </SettingsScreen>
  );
}
