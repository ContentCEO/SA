import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, mailboxes, threads, workspaces } from "@/db/schema";
import { clearedFacts, injectionClearable } from "./injection-clear-rules";
import { effectiveStatus, isReadOnly, ReadOnlyError } from "./lifecycle";

/**
 * Check 22 P2: "This is a normal email". The owner says a card marked as trying to instruct the
 * assistant is ordinary mail (a bookkeeper asking for invoices, a gate code that changed). The
 * mark goes, the thread stops carrying it to the next email, and the card shows what the owner
 * rules said without it. Refused for hidden or encoded text, another workspace's thread and
 * read-only accounts. Autopilot keeps away from the thread for 30 days. Sends nothing; the
 * Activity row is content-free.
 */
export async function clearInjectionMark(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<"cleared" | "not_found" | "not_clearable"> {
  const [row] = await db()
    .select({ thread: threads, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row) return "not_found";
  if (isReadOnly(row.workspace, now)) throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  const t = row.thread;
  if (!injectionClearable(t.extracted)) return "not_clearable";
  const next = clearedFacts(
    (t.extracted ?? {}) as Record<string, unknown>,
    { needsOwnerManual: t.needsOwnerManual, needsOwnerReason: t.needsOwnerReason },
    now,
  );
  // Only while the mark is still there (a sort racing the tap re-reads it next time).
  const [done] = await db()
    .update(threads)
    .set({
      extracted: next.extracted,
      needsOwner: next.needsOwner,
      needsOwnerReason: next.needsOwnerReason,
      ...(next.priority ? { priority: next.priority } : {}),
    })
    .where(and(eq(threads.id, threadId), sql`${threads.extracted}->>'injection' = 'true'`))
    .returning({ id: threads.id });
  if (!done) return "not_clearable";
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "owner_cleared_injection",
    threadId,
    detail: {},
  });
  return "cleared";
}
