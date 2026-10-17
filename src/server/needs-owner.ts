import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, mailboxes, threads, workspaces } from "@/db/schema";
import { effectiveStatus, isReadOnly, ReadOnlyError } from "./lifecycle";
import { lastOutSql } from "./thread-sql";

/**
 * Check 10 P1: one rule for "this still needs you". `threads.needs_owner` is raised by the
 * sorter (or the owner's "This one needs me") and stays open until the owner answers after it
 * was raised: an owner email (a Gmail reply or an app send, never an unsent draft or a side
 * email to the crew) or "I called them" — `lastOutSql` already counts all of those.
 * Content-free: times and flags only.
 */

/**
 * When the flag was raised. Rows from before `needs_owner_since` existed fall back to the
 * sort time; an older manual mark has no time we trust, so it never lets go on its own (the
 * owner can take it off their list).
 */
const raisedAtSql = () =>
  sql`coalesce(${threads.needsOwnerSince}, case when ${threads.needsOwnerManual} then 'infinity'::timestamptz else ${threads.classifiedAt} end)`;

/** The owner answered after the flag went up. Never NULL. */
export const needsOwnerAnsweredSql = () =>
  sql<boolean>`coalesce(${lastOutSql()} > ${raisedAtSql()}, false)`;

/** "Open needs-you": flagged and not answered since. Never NULL. */
export const openNeedsOwnerSql = () =>
  sql<boolean>`(${threads.needsOwner} and not ${needsOwnerAnsweredSql()})`;

/** Who let go of the flag, for the content-free activity row. */
export type ClearedBy = "gmail_reply" | "phone" | "owner";

async function logCleared(rows: { id: string; workspaceId: string }[], by: ClearedBy) {
  if (!rows.length) return;
  await db()
    .insert(activityLog)
    .values(
      rows.map((r) => ({
        workspaceId: r.workspaceId,
        actor: by === "gmail_reply" ? ("squared_away" as const) : ("owner" as const),
        action: "needs_owner_cleared",
        threadId: r.id,
        detail: { by },
      })),
    );
}

const CLEARED = { needsOwner: false, needsOwnerManual: false, needsOwnerReason: null } as const;

/**
 * After a sync run stored mail: let go of every flag in this mailbox the owner has answered
 * since it went up. One UPDATE, re-checked in its own WHERE. Returns how many.
 */
export async function clearAnsweredNeedsOwner(mailboxId: string): Promise<number> {
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  if (!box) return 0;
  const cleared = await db()
    .update(threads)
    .set({ ...CLEARED, needsOwnerSince: null })
    .where(
      and(eq(threads.mailboxId, mailboxId), eq(threads.needsOwner, true), needsOwnerAnsweredSql()),
    )
    .returning({ id: threads.id });
  await logCleared(
    cleared.map((c) => ({ id: c.id, workspaceId: box.workspaceId })),
    "gmail_reply",
  );
  return cleared.length;
}

/**
 * Take the flag off one thread now (the owner's "Take it off my list", or "I called them").
 * Only a flagged thread changes and logs. Caller has checked ownership and read-only.
 */
export async function clearNeedsOwnerNow(
  workspaceId: string,
  threadId: string,
  by: Exclude<ClearedBy, "gmail_reply">,
): Promise<boolean> {
  const cleared = await db()
    .update(threads)
    .set({ ...CLEARED, needsOwnerSince: null })
    .where(and(eq(threads.id, threadId), eq(threads.needsOwner, true)))
    .returning({ id: threads.id });
  await logCleared(
    cleared.map((c) => ({ id: c.id, workspaceId })),
    by,
  );
  return cleared.length > 0;
}

/**
 * The owner's "Take it off my list" on an Inbox card. Scoped to their workspace; refused for
 * read-only accounts (ReadOnlyError). Drafts and sends nothing.
 */
export async function takeOffMyList(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<"cleared" | "not_flagged" | "not_found"> {
  const [row] = await db()
    .select({ id: threads.id, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row) return "not_found";
  if (isReadOnly(row.workspace, now)) throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  return (await clearNeedsOwnerNow(workspaceId, threadId, "owner")) ? "cleared" : "not_flagged";
}
