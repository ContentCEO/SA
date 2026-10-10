"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { holdAutopilot } from "@/server/autopilot";
import { isTweak } from "@/ai/prompts/revise.v1";
import { draftSendQueued, enqueue } from "@/jobs/client";
import { isBatchCategory } from "@/server/batch-rules";
import {
  batchSend,
  createDraftForThread,
  discardDraft,
  queueSend,
  reviseDraft,
  saveDraftEdit,
  undoSend,
} from "@/server/drafts";
import { isSnoozeChoice } from "@/server/snooze-rules";
import { snoozeThread } from "@/server/snooze";
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
    outcome = await queueSend(workspace.id, draftId.data, {
      editedBody: editedBody?.data,
      device: await device(),
    });
  } catch (err) {
    if (err instanceof SendingBlockedError) redirect("/queue?error=blocked");
    throw err;
  }
  switch (outcome.status) {
    case "queued":
      await enqueue(
        draftSendQueued.create({ draftId: draftId.data, at: outcome.sendAfter.toISOString() }),
      );
      redirect(`/queue?sent=${draftId.data}`);
    case "already_sending":
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

/** For the proof-of-okay record (#41): phone or computer, from the browser's own description. */
async function device(): Promise<"phone" | "computer"> {
  const ua = (await headers()).get("user-agent") ?? "";
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? "phone" : "computer";
}

/** Plan #7: Undo, inside the window. */
export async function undoSendAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const ids = z.array(id).min(1).max(50).safeParse(formData.getAll("draftId"));
  if (!ids.success) redirect("/queue?error=unknown");
  let undone = 0;
  for (const d of ids.data) if (await undoSend(workspace.id, d)) undone++;
  redirect(undone ? "/queue?done=undone" : "/queue?error=toolate");
}

/** Plan #6: "Remind me". */
export async function snoozeAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const threadId = id.safeParse(formData.get("threadId"));
  const choice = formData.get("choice");
  if (!threadId.success || !isSnoozeChoice(choice)) redirect("/queue?error=unknown");
  const r = await snoozeThread(workspace.id, threadId.data, choice);
  redirect(r.status === "snoozed" ? "/queue?done=snoozed" : "/queue?error=snooze");
}

/** Plan #5: "Send N replies" after the confirmation. The server re-checks every one. */
export async function batchSendAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const ids = z.array(id).min(1).max(50).safeParse(formData.getAll("draftId"));
  const picked = formData.getAll("category").filter(isBatchCategory);
  if (!ids.success || picked.length === 0) redirect("/queue/review?error=none");
  for (let i = 0; i < ids.data.length; i++) {
    if (!(await hitLimit("send", workspace.id)).allowed) redirect("/queue?error=busy");
  }
  let r;
  try {
    r = await batchSend(workspace.id, ids.data, picked, { device: await device() });
  } catch (err) {
    if (err instanceof SendingBlockedError) redirect("/queue?error=blocked");
    throw err;
  }
  for (const q of r.queued)
    await enqueue(draftSendQueued.create({ draftId: q.draftId, at: q.sendAfter.toISOString() }));
  if (!r.queued.length) redirect("/queue/review?error=none");
  const qs = new URLSearchParams(r.queued.map((q) => ["sent", q.draftId]));
  if (r.refused) qs.set("refused", String(r.refused));
  redirect(`/queue?${qs}`);
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

/** Quick tweak chips (plan #3) and "Say a change" (plan #4). Rewrites the draft; never sends. */
export async function reviseDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const tweak = formData.get("tweak");
  const spoken = z.string().trim().min(2).max(500).safeParse(formData.get("spoken"));
  if (!isTweak(tweak) && !spoken.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("revise", workspace.id)).allowed) redirect("/queue?error=busy");
  let r;
  try {
    r = await reviseDraft(
      workspace.id,
      draftId.data,
      isTweak(tweak) ? { tweak } : { spoken: spoken.data! },
    );
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  const errors: Record<string, string> = {
    limit: "revisions",
    model_failed: "draftfailed",
    capped: "capped",
    deleted_in_gmail: "deleted",
    reconnect_needed: "reconnect",
    not_found: "unknown",
  };
  redirect(r.status === "revised" ? "/queue?done=revised" : `/queue?error=${errors[r.status]}`);
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
