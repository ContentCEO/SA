"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { enqueue, foundMoneyDraftsRequested } from "@/jobs/client";
import { claimFoundMoneyDrafts, hideFirstLook, markAnsweredByPhone } from "@/server/first-week";
import { ReadOnlyError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

/** Round 2 (FW E11): "I called them". No draft, no nudge; it counts as answered. */
export async function answeredByPhoneAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const threadId = z.string().uuid().safeParse(formData.get("threadId"));
  if (!threadId.success) redirect("/queue?error=unknown");
  let r;
  try {
    r = await markAnsweredByPhone(workspace.id, threadId.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  // Leads package: the same mark says "Done" on lead-site, voicemail and emergency cards.
  const done = formData.get("as") === "done" ? "done" : "called";
  // Check 9 P5: land on the next card, not the top of the queue.
  // (The card's own id when it was the last one, so the URL still changes.)
  const next = z.string().uuid().safeParse(formData.get("nextThreadId"));
  const t = r === "marked" && next.success ? next.data : threadId.data;
  redirect(r === "marked" ? `/queue?done=${done}&t=${t}` : `/queue?error=unknown&t=${t}`);
}

/** Round 2 (FW D1): hide the "your last 30 days" card. */
export async function hideFirstLookAction() {
  const { workspace } = await requireOwner();
  await hideFirstLook(workspace.id);
  redirect("/queue");
}

/** Round 2 (FW D2): draft replies and nudges for the quotes that slipped. Drafts only. */
export async function foundMoneyDraftsAction() {
  const { workspace } = await requireOwner();
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/queue?error=busy");
  let found;
  try {
    found = await claimFoundMoneyDrafts(workspace);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  if (!found || found.replies.length + found.nudges.length === 0) redirect("/queue");
  await enqueue(foundMoneyDraftsRequested.create({ workspaceId: workspace.id, ...found }));
  redirect("/queue?done=found_money");
}
