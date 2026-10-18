"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { holdAutopilot } from "@/server/autopilot";
import { isOpeningTweak } from "@/ai/prompts/opening-tweaks.v1";
import { isTweak } from "@/ai/prompts/revise.v2";
import { draftSendQueued, enqueue } from "@/jobs/client";
import { isTemporaryAiFailure } from "@/ai/client";
import { isBatchCategory } from "@/server/batch-rules";
import {
  batchSend,
  createDraftForThread,
  bodyHash,
  discardDraft,
  pendingDraftCreatedAt,
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
import { QUEUE_ERRORS } from "./queue-messages";

const id = z.string().uuid();
const body = z.string().trim().min(1, "The reply is empty.").max(20_000);
/** Check 9 P1: the fingerprint (sha-256, hex) of the text a card or the review page showed. */
const seenHash = (v: FormDataEntryValue | null) =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
const address = (v: FormDataEntryValue | null) =>
  typeof v === "string" && v.length <= 320 ? v : undefined;

/**
 * Check 9 P5: the card to land on after a tap — the card itself (a refusal, a save, a quick
 * change) or the one after it (a send, a discard, a snooze), from the form's hidden
 * `threadId` / `nextThreadId`. Only a uuid ever goes into the URL.
 */
const cardOf = (v: FormDataEntryValue | null) => {
  const r = id.safeParse(v);
  return r.success ? r.data : null;
};
const thisCard = (formData: FormData) => cardOf(formData.get("threadId"));
/**
 * The next card, or this card's own id when it was the only one: the URL then still changes
 * (a redirect to the very URL the page is on, less its `#t-…`, isn't applied by the router),
 * and with the card gone the notice simply shows at the top.
 */
const nextCard = (formData: FormData) => cardOf(formData.get("nextThreadId")) ?? thisCard(formData);
/** `&t=<uuid>` for a `/queue?…` path (ScrollToThread scrolls there; the notice sits on it). */
const at = (t: string | null) => (t ? `&t=${t}` : "");

/**
 * What a Send reply tap came to: a place to go (sent, or the card is gone), or a refusal that
 * leaves the draft waiting — always with nothing sent. Shared by the card's Send reply and the
 * Edit box's (which shows a refusal inside the card instead of leaving it).
 */
type SendTap =
  | { go: "sent" | "deleted" | "gone" | "unknown"; draftId: string }
  | { refused: string; changed?: boolean; at?: number };

/** Where a tap that left the card goes: always one of our own paths, at the next card. */
function goAfterTap(
  r: { go: "sent" | "deleted" | "gone" | "unknown"; draftId: string },
  formData: FormData,
): never {
  const next = nextCard(formData);
  switch (r.go) {
    case "sent":
      redirect(`/queue?sent=${r.draftId}${at(next)}`);
    case "deleted":
      redirect(`/queue?error=deleted${at(next)}`);
    case "gone":
      redirect(`/queue?error=gone${at(next)}`);
    default:
      redirect(`/queue?error=unknown${at(thisCard(formData))}`);
  }
}

async function sendTap(workspaceId: string, formData: FormData): Promise<SendTap> {
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) return { go: "unknown", draftId: "" };
  const edited = formData.get("body");
  const editedBody = typeof edited === "string" ? body.safeParse(edited) : null;
  if (editedBody && !editedBody.success) return { refused: "empty" };
  if (!(await hitLimit("send", workspaceId)).allowed) return { refused: "busy" };
  // The "To:" the card showed (H7). Missing (an old page) = not checked.
  const seenTo = address(formData.get("seenTo"));
  // Check 9 P1: the text the card showed. Every card sends it; without it we can't tell what
  // the owner read, so nothing is queued and the queue shows the latest text.
  const seen = seenHash(formData.get("seen"));
  if (!seen) return { refused: "changed", changed: true };

  let outcome;
  try {
    outcome = await queueSend(workspaceId, draftId.data, {
      editedBody: editedBody?.data,
      device: await device(),
      seenTo,
      seenHash: seen,
      // Check 43 P7: tapped "Send reply anyway" under the timing note.
      confirmedTiming: formData.get("confirmedTiming") === "1",
    });
  } catch (err) {
    if (err instanceof SendingBlockedError) return { refused: "blocked" };
    throw err;
  }
  switch (outcome.status) {
    case "queued":
      await enqueue(
        draftSendQueued.create({ draftId: draftId.data, at: outcome.sendAfter.toISOString() }),
      );
      return { go: "sent", draftId: draftId.data };
    case "already_sending":
      return { go: "sent", draftId: draftId.data };
    case "changed_in_gmail":
    case "changed_since_seen":
      return { refused: "changed", changed: true };
    case "answered_elsewhere":
      // Check 42 P1: no "Send anyway". The owner can tap Draft a reply for a second message.
      return { refused: "answered", at: outcome.at.getTime() };
    case "to_changed":
      return { refused: "to_changed" };
    case "gaps_unfilled":
      return { refused: "gaps" };
    case "no_reply_address":
      return { refused: "no_reply_address" };
    case "text_address":
      return { refused: "textaddr" };
    case "deleted_in_gmail":
      return { go: "deleted", draftId: draftId.data };
    case "reconnect_needed":
      return { refused: "reconnect" };
    case "mailbox_paused":
      return { refused: "paused" };
    case "gmail_busy":
    case "gmail_failed":
      return { refused: outcome.status };
    case "timing_check":
      return { refused: "timing" };
    case "not_found":
      return { go: "gone", draftId: draftId.data };
    default:
      return { refused: "unknown" };
  }
}

export async function sendDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const r = await sendTap(workspace.id, formData);
  if ("go" in r) goAfterTap(r, formData);
  if (r.refused === "answered") {
    // Only reached for a valid draft id (sendTap checked it).
    const d = id.parse(formData.get("draftId"));
    redirect(`/queue?error=answered&d=${d}&at=${r.at}`);
  }
  // A refusal leaves the draft waiting: back to the same card, with the words on it.
  redirect(`/queue?error=${r.refused}${at(thisCard(formData))}`);
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
  const here = thisCard(formData);
  if (!(await hitLimit("send", workspace.id)).allowed) redirect(`/queue?error=busy${at(here)}`);
  let r;
  try {
    r = await practiceSend(workspace.id, draftId.data, {
      editedBody: typeof edited === "string" ? edited : undefined,
    });
  } catch (err) {
    if (err instanceof SendingBlockedError) redirect(`/queue?error=blocked${at(here)}`);
    throw err;
  }
  if (r.status === "sent") redirect(`/queue?done=practice&left=${r.left}${at(here)}`);
  redirect(
    `/queue?error=${r.status === "limit" ? "practice_limit" : r.status === "reconnect_needed" ? "reconnect" : r.status === "mailbox_paused" ? "paused" : "unknown"}${at(here)}`,
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
  redirect(
    r.status === "snoozed"
      ? `/queue?done=snoozed${at(nextCard(formData))}`
      : `/queue?error=snooze${at(threadId.data)}`,
  );
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
const CHANGED_WHILE_EDITING_SEND =
  "This reply changed while you were editing, so nothing was sent. Here's the newest version; make your change again, then tap Send reply.";
const GAPS_IN_EDITOR = "Replace each [ ] before sending. Nothing was sent.";

/** The newest text of a draft, as the editor needs it: the text and its fingerprint. */
async function latestFor(workspaceId: string, draftId: string) {
  const text = await pendingDraftText(workspaceId, draftId);
  return text === null ? null : { body: text, hash: bodyHash(text) };
}

/**
 * The Edit box's Save changes and Send reply (Check 9 P4, Check 42 P2). A refusal comes back to
 * the open editor with the words inside the card — nothing typed is lost; only a save or send
 * that worked, or a draft that's gone, leaves the card.
 */
export async function editorAction(_prev: EditorState, formData: FormData): Promise<EditorState> {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const typed = typeof formData.get("body") === "string" ? String(formData.get("body")) : "";
  const keep = (message: string): EditorState => ({ message, latest: null, typed: null });
  const changed = async (message: string): Promise<EditorState> => {
    const latest = await latestFor(workspace.id, draftId.data);
    if (!latest) redirect("/queue?error=gone");
    return { message, latest, typed };
  };

  if (formData.get("intent") === "send") {
    const r = await sendTap(workspace.id, formData);
    if ("go" in r) goAfterTap(r, formData);
    if (r.refused === "answered") redirect(`/queue?error=answered&d=${draftId.data}&at=${r.at}`);
    if (r.changed) return changed(CHANGED_WHILE_EDITING_SEND);
    if (r.refused === "gaps") return keep(GAPS_IN_EDITOR);
    return keep(QUEUE_ERRORS[r.refused] ?? QUEUE_ERRORS.unknown!);
  }

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
      redirect(`/queue?done=saved${at(thisCard(formData))}`);
    case "changed_in_gmail":
    case "changed_since_opened":
      return changed(CHANGED_WHILE_EDITING);
    case "deleted_in_gmail":
      redirect("/queue?error=deleted");
    case "mailbox_paused":
      redirect("/queue?error=paused");
    case "reconnect_needed":
      return keep("Google access was lost. Nothing was saved. Reconnect Gmail in Settings.");
    case "gmail_busy":
      return keep("Gmail asked us to slow down. Nothing was saved. Try again in a minute.");
    case "gmail_failed":
      return keep("Gmail didn't answer, so nothing was saved. Try again in a minute.");
    default:
      redirect("/queue?error=gone");
  }
}

export async function discardDraftAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const here = thisCard(formData);
  if (!(await hitLimit("gmailWrite", workspace.id)).allowed)
    redirect(`/queue?error=busy${at(here)}`);
  let r;
  try {
    r = await discardDraft(workspace.id, draftId.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(`/queue?error=readonly${at(here)}`);
    throw err;
  }
  // Check 9 P3: Gmail didn't answer — the draft is still there, nothing changed.
  if (r === "gmail_busy" || r === "gmail_failed") redirect(`/queue?error=${r}_discard${at(here)}`);
  redirect(`/queue?done=discarded${at(nextCard(formData))}`);
}

/**
 * Check 9 P9: after "already a draft", the waiting draft's time — waiting up to 25 seconds for
 * another run (the first tap) that is still writing it.
 */
async function waitForPendingDraft(workspaceId: string, threadId: string) {
  for (let i = 0; i < 25; i++) {
    const at = await pendingDraftCreatedAt(workspaceId, threadId);
    if (at) return at;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** "Draft a reply" — the owner asked, so this runs now rather than waiting for the background job. */
export async function draftReplyAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const threadId = id.safeParse(formData.get("threadId"));
  if (!threadId.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/queue?error=busy");
  let r;
  try {
    r = await createDraftForThread(threadId.data, {
      trigger: "owner",
      workspaceId: workspace.id,
      aiMode: "interactive",
    });
  } catch (err) {
    // Check 48 P4: the model is slow, down or missing — a plain retry message, never a hang.
    if (isTemporaryAiFailure(err)) redirect("/queue?error=ai_busy");
    throw err;
  }
  // Check 9 P5: the new draft card carries the same thread id, so the owner lands on it.
  if (r.status === "created") redirect(`/queue?done=drafted${at(threadId.data)}`);
  // Check 9 P9: a second tap while the first was writing (or just after) isn't an error — the
  // draft is there, or will be in a moment.
  if (r.status === "skipped" && r.reason === "already_pending") {
    const createdAt = await waitForPendingDraft(workspace.id, threadId.data);
    // The other run stopped without a draft: plain "try again", never "it's below".
    if (!createdAt) redirect(`/queue?error=draftfailed${at(threadId.data)}`);
    if (Date.now() - createdAt.getTime() < 60_000)
      redirect(`/queue?done=drafted${at(threadId.data)}`);
  }
  if (r.status === "reconnect_needed") redirect(`/queue?error=reconnect${at(threadId.data)}`);
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
  redirect(`/queue?error=${reasons[r.reason] ?? "draftfailed"}${at(threadId.data)}`);
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
      // Check 42 P2: the text the card showed when the change was asked for. Check 48 P4: a tap
      // waits at most the interactive time limit.
      { openedHash: seenHash(formData.get("seen")) ?? undefined, aiMode: "interactive" },
    );
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/queue?error=readonly");
    if (isTemporaryAiFailure(err)) redirect("/queue?error=ai_busy");
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
    gmail_busy: "gmail_busy",
    gmail_failed: "gmail_failed",
  };
  const here = thisCard(formData);
  redirect(
    r.status === "revised"
      ? `/queue?done=revised${at(here)}`
      : `/queue?error=${errors[r.status]}${at(here)}`,
  );
}

/** "Hold it": autopilot stands down; the draft waits for the owner like any other. */
export async function holdAutopilotAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const draftId = id.safeParse(formData.get("draftId"));
  if (!draftId.success) redirect("/queue?error=unknown");
  const r = await holdAutopilot(workspace.id, draftId.data);
  // Check 9 P2: "Held." only for a draft that did not go.
  if (r.status === "held") redirect(`/queue?done=held${at(thisCard(formData))}`);
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
