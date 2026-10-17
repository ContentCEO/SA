"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { holdAutopilot } from "@/server/autopilot";
import { isOpeningTweak } from "@/ai/prompts/opening-tweaks.v1";
import { isTweak } from "@/ai/prompts/revise.v2";
import { draftSendQueued, enqueue } from "@/jobs/client";
import { isBatchCategory } from "@/server/batch-rules";
import {
  batchSend,
  createDraftForThread,
  bodyHash,
  discardDraft,
  pendingDraftText,
  queueSend,
  reviseDraft,
  saveDraftEdit,
  undoSend,
} from "@/server/drafts";
import { isSnoozeChoice } from "@/server/snooze-rules";
import { practiceSend } from "@/server/practice";
import { snoozeThread } from "@/server/snooze";
import { ReadOnlyError, SendingBlockedError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";
import { dismissChecklist } from "@/server/onboarding";
import { requireOwner } from "@/server/session";

const id = z.string().uuid();
const body = z.string().trim().min(1, "The reply is empty.").max(20_000);
/** Check 9 P1: the fingerprint (sha-256, hex) of the text a card or the review page showed. */
const seenHash = (v: FormDataEntryValue | null) =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
const address = (v: FormDataEntryValue | null) =>
  typeof v === "string" && v.length <= 320 ? v : undefined;

export async function sendDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const edited = formData.get("body");
  const editedBody = typeof edited === "string" ? body.safeParse(edited) : null;
  if (editedBody && !editedBody.success) redirect("/queue?error=empty");
  if (!(await hitLimit("send", workspace.id)).allowed) redirect("/queue?error=busy");
  // The "To:" the card showed (H7). Missing (an old page) = not checked.
  const seenTo = address(formData.get("seenTo"));
  // Check 9 P1: the text the card showed. Every card sends it; without it we can't tell what
  // the owner read, so nothing is queued and the queue shows the latest text.
  const seen = seenHash(formData.get("seen"));
  if (!seen) redirect("/queue?error=changed");

  let outcome;
  try {
    outcome = await queueSend(workspace.id, draftId.data, {
      editedBody: editedBody?.data,
      device: await device(),
      seenTo,
      seenHash: seen,
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
    case "changed_since_seen":
      redirect("/queue?error=changed");
    case "answered_elsewhere":
      // Check 42 P1: no "Send anyway". The owner can tap Draft a reply for a second message.
      redirect(`/queue?error=answered&d=${draftId.data}&at=${outcome.at.getTime()}`);
    case "to_changed":
      redirect("/queue?error=to_changed");
    case "gaps_unfilled":
      redirect("/queue?error=gaps");
    case "no_reply_address":
      redirect("/queue?error=no_reply_address");
    case "text_address":
      redirect("/queue?error=textaddr");
    case "deleted_in_gmail":
      redirect("/queue?error=deleted");
    case "reconnect_needed":
      redirect("/queue?error=reconnect");
    case "mailbox_paused":
      redirect("/queue?error=paused");
    case "not_found":
      redirect("/queue?error=gone");
    default:
      redirect("/queue?error=unknown");
  }
}

/** For the proof-of-okay record (#41): phone or computer, from the browser's own description. */
async function device(): Promise<"phone" | "computer"> {
  const ua = (await headers()).get("user-agent") ?? "";
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? "phone" : "computer";
}

/** Plan #40: during the three days, send a practice copy to the owner only. */
export async function practiceSendAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const edited = formData.get("body");
  if (!(await hitLimit("send", workspace.id)).allowed) redirect("/queue?error=busy");
  let r;
  try {
    r = await practiceSend(workspace.id, draftId.data, {
      editedBody: typeof edited === "string" ? edited : undefined,
    });
  } catch (err) {
    if (err instanceof SendingBlockedError) redirect("/queue?error=blocked");
    throw err;
  }
  if (r.status === "sent") redirect(`/queue?done=practice&left=${r.left}`);
  redirect(
    `/queue?error=${r.status === "limit" ? "practice_limit" : r.status === "reconnect_needed" ? "reconnect" : r.status === "mailbox_paused" ? "paused" : "unknown"}`,
  );
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
  // Check 9 P1: what the review page showed for each reply (its text's fingerprint and the
  // address). A reply without one, or changed since, is refused and stays on the queue.
  const seen = new Map<string, { hash: string; to?: string }>();
  for (const d of ids.data) {
    const hash = seenHash(formData.get(`seen:${d}`));
    if (hash) seen.set(d, { hash, to: address(formData.get(`seenTo:${d}`)) });
  }
  let r;
  try {
    r = await batchSend(workspace.id, ids.data, picked, { device: await device(), seen });
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

/**
 * The Edit box's state (Check 42 P2): a message shown inside the card, and — when the reply
 * changed while it was open — the newest text to edit, with what the person typed kept below.
 */
export type EditorState = {
  message: string | null;
  latest: { body: string; hash: string } | null;
  typed: string | null;
};

const CHANGED_WHILE_EDITING =
  "This reply changed while you were editing. Here's the newest version; make your change again. Nothing was saved or sent.";

/** The newest text of a draft, as the editor needs it: the text and its fingerprint. */
async function latestFor(workspaceId: string, draftId: string) {
  const text = await pendingDraftText(workspaceId, draftId);
  return text === null ? null : { body: text, hash: bodyHash(text) };
}

/**
 * Save changes from the Edit box. Refusals come back to the open editor (nothing typed is
 * lost); only a save that worked, or a draft that's gone, leaves the card.
 */
export async function editorAction(_prev: EditorState, formData: FormData): Promise<EditorState> {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const typed = typeof formData.get("body") === "string" ? String(formData.get("body")) : "";
  const keep = (message: string): EditorState => ({ message, latest: null, typed: null });
  const text = body.safeParse(typed);
  if (!text.success) return keep("The reply is empty, so nothing was saved.");
  if (!(await hitLimit("gmailWrite", workspace.id)).allowed)
    return keep(
      "That's a lot in a short time, so we've paused it for a bit. Nothing was saved. Try again in a few minutes.",
    );
  const opened = seenHash(formData.get("opened")) ?? undefined;
  let r;
  try {
    r = await saveDraftEdit(workspace.id, draftId.data, text.data, { openedHash: opened });
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    throw err;
  }
  switch (r) {
    case "saved":
      redirect("/queue?done=saved");
    case "changed_in_gmail":
    case "changed_since_opened": {
      const latest = await latestFor(workspace.id, draftId.data);
      if (!latest) redirect("/queue?error=gone");
      return { message: CHANGED_WHILE_EDITING, latest, typed };
    }
    case "deleted_in_gmail":
      redirect("/queue?error=deleted");
    case "mailbox_paused":
      redirect("/queue?error=paused");
    case "reconnect_needed":
      return keep("Google access was lost. Nothing was saved. Reconnect Gmail in Settings.");
    default:
      redirect("/queue?error=gone");
  }
}

export async function discardDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("gmailWrite", workspace.id)).allowed) redirect("/queue?error=busy");
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
    gmail_busy: "gmail_busy",
    reply_to_unread: "reply_to_unread",
    no_reply_address: "no_reply_address",
    text_address: "textaddr",
    lead_site: "leadsite",
    phone_message: "phonemsg",
    mailbox_paused: "paused",
  };
  redirect(`/queue?error=${reasons[r.reason] ?? "draftfailed"}`);
}

/**
 * Quick tweak chips (plan #3), "Say a change" (plan #4) and, on a first reply to a new lead,
 * "Other ways to reply" (replies package). Rewrites the draft; never sends.
 */
export async function reviseDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const tweak = formData.get("tweak");
  const opening = formData.get("opening");
  const spoken = z.string().trim().min(2).max(500).safeParse(formData.get("spoken"));
  if (!isTweak(tweak) && !isOpeningTweak(opening) && !spoken.success)
    redirect("/queue?error=unknown");
  if (!(await hitLimit("revise", workspace.id)).allowed) redirect("/queue?error=busy");
  let r;
  try {
    r = await reviseDraft(
      workspace.id,
      draftId.data,
      isTweak(tweak) ? { tweak } : isOpeningTweak(opening) ? { opening } : { spoken: spoken.data! },
      // Check 42 P2: the text the card showed when the change was asked for.
      { openedHash: seenHash(formData.get("seen")) ?? undefined },
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
    mailbox_paused: "paused",
    not_found: "unknown",
    not_first_contact: "unknown",
    changed_in_gmail: "changed_editing",
    changed_since_opened: "changed_editing",
  };
  redirect(r.status === "revised" ? "/queue?done=revised" : `/queue?error=${errors[r.status]}`);
}

/** "Hold it": autopilot stands down; the draft waits for the owner like any other. */
export async function holdAutopilotAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const r = await holdAutopilot(workspace.id, draftId.data);
  // Check 9 P2: "Held." only for a draft that did not go.
  if (r.status === "held") redirect("/queue?done=held");
  if (r.status === "too_late")
    redirect(
      r.sent ? `/queue?error=autopilot_sent&d=${draftId.data}` : "/queue?error=autopilot_sending",
    );
  redirect("/queue?error=hold_gone");
}

/** Hide the getting-started list — allowed only once every step is done. */
export async function dismissChecklistAction() {
  const { workspace } = await requireOwner();
  const ok = await dismissChecklist(workspace.id);
  redirect(ok ? "/queue" : "/queue?error=unknown");
}
