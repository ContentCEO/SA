"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { holdAutopilot } from "@/server/autopilot";
import { createDraftForThread, discardDraft, saveDraftEdit, sendDraft } from "@/server/drafts";
import { ReadOnlyError, SendingBlockedError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";
import { dismissChecklist } from "@/server/onboarding";
import { requireOwner } from "@/server/session";

const id = z.string().uuid();
const body = z.string().trim().min(1, "The reply is empty.").max(20_000);

export async function sendDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const edited = formData.get("body");
  const editedBody = typeof edited === "string" ? body.safeParse(edited) : null;
  if (editedBody && !editedBody.success) redirect("/queue?error=empty");
  if (!(await hitLimit("send", workspace.id)).allowed) redirect("/queue?error=busy");

  let outcome;
  try {
    outcome = await sendDraft(workspace.id, draftId.data, { editedBody: editedBody?.data });
  } catch (err) {
    if (err instanceof SendingBlockedError) redirect("/queue?error=blocked");
    throw err;
  }
  switch (outcome.status) {
    case "sent":
      redirect(`/queue?sent=${draftId.data}`);
    case "changed_in_gmail":
      redirect("/queue?error=changed");
    case "gaps_unfilled":
      redirect("/queue?error=gaps");
    case "deleted_in_gmail":
      redirect("/queue?error=deleted");
    case "reconnect_needed":
      redirect("/queue?error=reconnect");
    default:
      redirect("/queue?error=unknown");
  }
}

export async function saveDraftEditAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  const text = body.safeParse(formData.get("body"));
  if (!draftId.success) redirect("/queue?error=unknown");
  if (!text.success) redirect("/queue?error=empty");
  let r;
  try {
    r = await saveDraftEdit(workspace.id, draftId.data, text.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  redirect(
    r === "saved"
      ? "/queue?done=saved"
      : r === "deleted_in_gmail"
        ? "/queue?error=deleted"
        : "/queue?error=unknown",
  );
}

export async function discardDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  try {
    await discardDraft(workspace.id, draftId.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  redirect("/queue?done=discarded");
}

/** "Draft a reply" — the owner asked, so this runs now rather than waiting for the background job. */
export async function draftReplyAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const threadId = id.safeParse(formData.get("threadId"));
  if (!threadId.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/queue?error=busy");
  const r = await createDraftForThread(threadId.data, {
    trigger: "owner",
    workspaceId: workspace.id,
  });
  if (r.status === "created") redirect("/queue?done=drafted");
  if (r.status === "reconnect_needed") redirect("/queue?error=reconnect");
  const reasons: Record<string, string> = {
    already_pending: "exists",
    owner_replied_last: "replied",
    no_text: "notext",
    capped: "capped",
    read_only: "readonly",
  };
  redirect(`/queue?error=${reasons[r.reason] ?? "draftfailed"}`);
}

/** "Hold it": autopilot stands down; the draft waits for the owner like any other. */
export async function holdAutopilotAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const held = await holdAutopilot(workspace.id, draftId.data);
  redirect(held ? "/queue?done=held" : "/queue?error=unknown");
}

/** Hide the getting-started list — allowed only once every step is done. */
export async function dismissChecklistAction() {
  const { workspace } = await requireOwner();
  const ok = await dismissChecklist(workspace.id);
  redirect(ok ? "/queue" : "/queue?error=unknown");
}
