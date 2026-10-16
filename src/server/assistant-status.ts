import "server-only";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { aiCallsToday, utcDay } from "@/ai/usage";
import { dailyAiCallCap } from "@/config/models";
import { db } from "@/db";
import { businessProfiles, mailboxes, messages, threads, usage, workspaces } from "@/db/schema";
import { assistantNotice, UNSORTED_NOTICE_MS, UNSORTED_SWEEP_MS } from "./assistant-status-rules";
import { CLASSIFY_LOOKBACK_DAYS } from "./classification";
import { jobsAllowed } from "./lifecycle";

/** Inbound inbox mail nobody has sorted yet, older than `olderThanMs`, within the lookback. */
function unsortedWhere(now: Date, olderThanMs: number) {
  return and(
    eq(messages.direction, "in"),
    isNull(messages.classifiedAt),
    gte(messages.sentAt, new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000)),
    lte(messages.createdAt, new Date(now.getTime() - olderThanMs)),
    eq(threads.inInbox, true),
  );
}

/**
 * Review D4: mailboxes with mail that waited over 10 minutes unsorted (an AI outage, a job
 * that died), whose account still sorts and hasn't used up today's AI limit. The 15-minute
 * job asks each to sort again; sorting itself skips anything it shouldn't touch.
 */
export async function unsortedSweepMailboxes(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ mailbox: mailboxes.id, workspace: workspaces })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(unsortedWhere(now, UNSORTED_SWEEP_MS), eq(mailboxes.status, "active")));
  const live = rows.filter((r) => jobsAllowed(r.workspace, now));
  if (!live.length) return [];
  const capped = new Set(
    (
      await db()
        .select({ workspaceId: usage.workspaceId })
        .from(usage)
        .where(
          and(
            eq(usage.period, utcDay(now)),
            inArray(usage.workspaceId, [...new Set(live.map((r) => r.workspace.id))]),
            sql`${usage.aiCalls} >= ${dailyAiCallCap()}`,
          ),
        )
    ).map((r) => r.workspaceId),
  );
  return live.filter((r) => !capped.has(r.workspace.id)).map((r) => r.mailbox);
}

/** The note for the top of the owner's screens (C6, C7), or null. Counts only. */
export async function assistantStatus(
  workspace: Parameters<typeof jobsAllowed>[0] & { id: string },
  now: Date = new Date(),
) {
  const readOnly = !jobsAllowed(workspace, now);
  if (readOnly) return null;
  const [{ calls, cap }, [unsorted], [profile]] = await Promise.all([
    aiCallsToday(workspace.id, now),
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(
        and(
          eq(mailboxes.workspaceId, workspace.id),
          eq(mailboxes.status, "active"),
          unsortedWhere(now, UNSORTED_NOTICE_MS),
        ),
      ),
    db()
      .select({ timeZone: businessProfiles.timeZone })
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspace.id)),
  ]);
  return assistantNotice({
    calls,
    cap,
    unsorted: Number(unsorted?.n ?? 0),
    readOnly,
    now,
    timeZone: profile?.timeZone ?? null,
  });
}
