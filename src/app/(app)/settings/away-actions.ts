"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { turnAwayOff, turnAwayOn } from "@/server/away";
import { ReadOnlyError } from "@/server/lifecycle";
import { removeRule } from "@/server/sender-rule-store";
import { requireOwner } from "@/server/session";

/** Ideas E7: "Turn on away mode". The day back is checked in the owner's own calendar. */
export async function turnAwayOnAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const tz = formData.get("timeZone");
  let r;
  try {
    r = await turnAwayOn(workspace, formData.get("backOn"), {
      timeZone: typeof tz === "string" ? tz.slice(0, 64) : null,
    });
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/settings/away?error=readonly");
    throw err;
  }
  if (r === "past") redirect("/settings/away?error=away_past");
  if (r === "too_far") redirect("/settings/away?error=away_too_far");
  if (r === "invalid") redirect("/settings/away?error=away_invalid");
  redirect("/settings/away?done=away_on");
}

/** "I'm back — turn it off" (Settings) and "Turn off away mode" (the queue). */
export async function turnAwayOffAction(formData: FormData) {
  const { workspace } = await requireOwner();
  await turnAwayOff(workspace.id);
  if (formData.get("back") === "queue") redirect("/queue?done=away_off");
  redirect("/settings/away?done=away_off");
}

/** Ideas H3: "Remove rule" on Settings → Sender rules, after its confirm. */
export async function removeSenderRuleAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/settings/sender-rules?error=unknown");
  const ok = await removeRule(workspace.id, id.data);
  redirect(
    ok ? "/settings/sender-rules?done=rule_removed" : "/settings/sender-rules?error=unknown",
  );
}
