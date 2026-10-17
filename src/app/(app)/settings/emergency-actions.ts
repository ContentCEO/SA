"use server";

import { redirect } from "next/navigation";
import { setEmergencyAlerts } from "@/server/emergency-alerts";
import { requireOwner } from "@/server/session";

/**
 * Replies package (B5 part 2): "Emergencies, even at night", one switch for the account,
 * shown on both the Notifications and the Text alerts screens. Back to the screen it was on.
 */
export async function saveEmergencyAlertsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  await setEmergencyAlerts(workspace.id, formData.get("enabled") === "on");
  if (formData.get("from") === "texts") redirect("/settings/texts?done=saved");
  redirect("/settings/notifications?done=saved");
}
