"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { addServiceTown, closeComplaintCheckin, markComplaintFixed } from "@/server/leads";
import { ReadOnlyError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

/**
 * Leads package: the lead cards' taps. Every ?done= / ?error= code is a fixed [a-z_] word —
 * no name, town or address ever reaches a URL.
 */
const threadId = (formData: FormData) => z.string().uuid().safeParse(formData.get("threadId"));

async function readOnlyGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
}

/** G5: "Mark fixed" on a complaint. */
export async function markFixedAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = threadId(formData);
  if (!id.success) redirect("/queue?error=unknown");
  const r = await readOnlyGuard(() => markComplaintFixed(workspace.id, id.data));
  redirect(
    r === "fixed"
      ? "/queue?done=fixed"
      : r === "has_draft"
        ? "/queue?error=has_draft"
        : "/queue?error=unknown",
  );
}

/** G5: "All good" on a check-in. */
export async function closeCheckinAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = threadId(formData);
  if (!id.success) redirect("/queue?error=unknown");
  const r = await readOnlyGuard(() => closeComplaintCheckin(workspace.id, id.data));
  redirect(r === "closed" ? "/queue?done=checkin_closed" : "/queue?error=unknown");
}

/** B9: "Add <town> to my towns". The town is read from the thread, never from the form. */
export async function addTownAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = threadId(formData);
  if (!id.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/queue?error=busy");
  const r = await readOnlyGuard(() => addServiceTown(workspace.id, id.data));
  redirect(r === "added" ? "/queue?done=town_added" : "/queue?error=unknown");
}
