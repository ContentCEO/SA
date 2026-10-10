import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads } from "@/db/schema";
import { isEmergency, snoozeUntil, type SnoozeChoice } from "./snooze-rules";

export async function workspaceTimeZone(workspaceId: string): Promise<string> {
  const [p] = await db()
    .select({ timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return p?.timeZone ?? "America/New_York";
}

/**
 * Plan #6 "Remind me": hide a conversation from the queue until the chosen
 * time. The rule for emergencies is checked here, not just in the menu.
 */
export async function snoozeThread(
  workspaceId: string,
  threadId: string,
  choice: SnoozeChoice,
  now: Date = new Date(),
): Promise<
  { status: "snoozed"; until: Date } | { status: "not_allowed" } | { status: "not_found" }
> {
  const [t] = await db()
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.id, threadId),
        inArray(
          threads.mailboxId,
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaceId)),
        ),
      ),
    );
  if (!t) return { status: "not_found" };
  const until = snoozeUntil(choice, now, await workspaceTimeZone(workspaceId), isEmergency(t));
  if (!until) return { status: "not_allowed" };
  await db().update(threads).set({ snoozedUntil: until }).where(eq(threads.id, t.id));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "snoozed",
    threadId: t.id,
    detail: { choice },
  });
  return { status: "snoozed", until };
}
