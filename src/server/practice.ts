import "server-only";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, drafts, mailboxes, workspaces } from "@/db/schema";
import { MailboxAuthError, type MailboxWriter } from "@/mailbox/connector";
import { buildReplyMime } from "@/mailbox/mime";
import {
  canPracticeSend,
  effectiveStatus,
  onlyToOwner,
  PRACTICE_SEND_LIMIT,
  SendingBlockedError,
} from "./lifecycle";
import { defaultWriter } from "./drafts";
import { markReconnectNeeded } from "./sync";

export type PracticeOutcome =
  | { status: "sent"; to: string; left: number }
  | { status: "limit" }
  | { status: "not_found" }
  | { status: "reconnect_needed" }
  /** The plan covers fewer Gmail addresses and this one is paused (2026-10-16). */
  | { status: "mailbox_paused" };

export async function practiceSendsUsed(workspaceId: string): Promise<number> {
  const [r] = await db()
    .select({ n: count() })
    .from(activityLog)
    .where(and(eq(activityLog.workspaceId, workspaceId), eq(activityLog.action, "practice_sent")));
  return r?.n ?? 0;
}

/**
 * Plan #40 "Send it to yourself instead?". A brand-new message — not the
 * draft, not in the customer's thread — to the owner's own connected address,
 * subject "[Practice] …". Refused (SendingBlockedError → 403) outside
 * evaluation, and refused if the message we built would go anywhere else.
 * The draft itself stays in the queue, untouched.
 */
export async function practiceSend(
  workspaceId: string,
  draftId: string,
  opts: {
    writerFor?: (m: typeof mailboxes.$inferSelect) => MailboxWriter;
    now?: () => Date;
    editedBody?: string;
  } = {},
): Promise<PracticeOutcome> {
  const now = opts.now?.() ?? new Date();
  const [row] = await db()
    .select({ draft: drafts, mailbox: mailboxes, workspace: workspaces })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(drafts.id, draftId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row || row.draft.status !== "pending") return { status: "not_found" };
  const { draft, mailbox, workspace } = row;
  if (!canPracticeSend(workspace, now)) {
    throw new SendingBlockedError(effectiveStatus(workspace, now));
  }
  if (mailbox.planPausedAt) return { status: "mailbox_paused" };
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  const used = await practiceSendsUsed(workspaceId);
  if (used >= PRACTICE_SEND_LIMIT) return { status: "limit" };

  const mime = buildReplyMime({
    from: mailbox.email,
    to: mailbox.email,
    subject: `[Practice] ${draft.subject}`,
    body: [
      `This is a practice copy. Your customer (${draft.toAddress}) did NOT get it.`,
      "During your three days, Squared Away only sends to you.",
      "",
      "---",
      "",
      opts.editedBody?.trim() || draft.body || "",
    ].join("\n"),
  });
  // The rule, checked on the exact bytes we're about to hand to Gmail.
  if (!onlyToOwner(mime, mailbox.email)) {
    throw new SendingBlockedError(effectiveStatus(workspace, now));
  }

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    await writer.sendMessage(Buffer.from(mime, "utf8").toString("base64url"));
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "practice_sent",
      threadId: draft.threadId,
      detail: { draftId: draft.id },
    });
  return { status: "sent", to: mailbox.email, left: PRACTICE_SEND_LIMIT - used - 1 };
}
