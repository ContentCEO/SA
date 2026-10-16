import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, drafts, mailboxes } from "@/db/schema";
import { GRACE_MINUTES } from "./autopilot";
import { buildSendRecord, type SendRecord } from "./send-record-rules";

/**
 * Plan #41 "See record": the proof of who okayed a sent reply. Built only from
 * the draft row and the content-free activity log; never from email text.
 * Null unless the draft is this workspace's and was sent.
 */
export async function sendRecord(
  workspaceId: string,
  draftId: string,
): Promise<(SendRecord & { toAddress: string }) | null> {
  const [d] = await db()
    .select({
      status: drafts.status,
      kind: drafts.kind,
      createdAt: drafts.createdAt,
      decidedAt: drafts.decidedAt,
      sentGmailMessageId: drafts.sentGmailMessageId,
      toAddress: drafts.toAddress,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.id, draftId),
        inArray(
          drafts.mailboxId,
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaceId)),
        ),
      ),
    );
  if (!d || (d.status !== "sent" && d.status !== "edited_and_sent")) return null;
  const logs = await db()
    .select({
      action: activityLog.action,
      actor: activityLog.actor,
      detail: activityLog.detail,
      at: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.workspaceId, workspaceId),
        sql`${activityLog.detail}->>'draftId' = ${draftId}`,
      ),
    )
    .orderBy(asc(activityLog.createdAt));
  // H7: the address it went to is part of the proof (the owner's own screen only).
  return { ...buildSendRecord(d, logs, GRACE_MINUTES), toAddress: d.toAddress };
}
