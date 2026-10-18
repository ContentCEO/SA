import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, drafts, mailboxes, threads, workspaces } from "@/db/schema";
import { playbookApplies } from "./complaint-rules";
import { effectiveStatus, isReadOnly, ReadOnlyError } from "./lifecycle";
import { normalizeTown, townFromAddress, townOnList } from "./service-area-rules";

/**
 * Leads package: the owner's taps on lead cards. Each one is scoped to the workspace, refused
 * for read-only accounts, and writes a content-free Activity row. None of them sends anything.
 */
async function ownedThread(workspaceId: string, threadId: string, now: Date) {
  const [row] = await db()
    .select({ thread: threads, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (row && isReadOnly(row.workspace, now))
    throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  return row?.thread ?? null;
}

async function hasPendingDraft(threadId: string) {
  const [d] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending")))
    .limit(1);
  return !!d;
}

/**
 * G5 "Mark fixed": the complaint is handled (it leaves Needs you like "I called them") and a
 * check-in comes back in two days if the customer hasn't written. Only on a complaint that
 * isn't a legal threat, and only with no draft waiting (Send or Discard that first).
 */
export async function markComplaintFixed(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<"fixed" | "not_found" | "not_complaint" | "has_draft"> {
  const t = await ownedThread(workspaceId, threadId, now);
  if (!t) return "not_found";
  if (!playbookApplies(t)) return "not_complaint";
  if (await hasPendingDraft(threadId)) return "has_draft";
  await db()
    .update(threads)
    .set({ complaintFixedAt: now, handledOfflineAt: now })
    .where(eq(threads.id, threadId));
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "complaint_fixed", threadId, detail: {} });
  return "fixed";
}

/** G5 "All good": closes the check-in for this fix. */
export async function closeComplaintCheckin(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<"closed" | "not_found"> {
  const t = await ownedThread(workspaceId, threadId, now);
  if (!t || !t.complaintFixedAt) return "not_found";
  await db().update(threads).set({ complaintCheckinDoneAt: now }).where(eq(threads.id, threadId));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "complaint_checkin_closed",
    threadId,
    detail: {},
  });
  return "closed";
}

/**
 * B9 "Add <town> to my towns": the town comes from the thread's own stored address, never from
 * the form. When "outside your towns" was the only reason the card needed the owner, the flag
 * is cleared so the next sort / draft treats it as ordinary work; otherwise it stays.
 */
export async function addServiceTown(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<"added" | "not_found" | "no_town"> {
  const t = await ownedThread(workspaceId, threadId, now);
  if (!t) return "not_found";
  const x = (t.extracted ?? {}) as { address?: unknown; owner_rule_hits?: unknown };
  const town = townFromAddress(typeof x.address === "string" ? x.address : null);
  if (!town) return "no_town";
  const [profile] = await db()
    .select({ towns: businessProfiles.serviceTowns })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const towns = profile?.towns ?? [];
  if (!townOnList(town, towns) && normalizeTown(town).name) {
    await db()
      .insert(businessProfiles)
      .values({ workspaceId, serviceTowns: [...towns, town], updatedAt: now })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: { serviceTowns: [...towns, town].slice(0, 100), updatedAt: now },
      });
  }
  const hits = Array.isArray(x.owner_rule_hits) ? x.owner_rule_hits : [];
  if (hits.length === 1 && hits[0] === "outside_area" && !t.needsOwnerManual) {
    await db()
      .update(threads)
      .set({ needsOwner: false, needsOwnerReason: null })
      .where(and(eq(threads.id, threadId), eq(threads.needsOwnerManual, false)));
  }
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "service_town_added", threadId, detail: {} });
  return "added";
}
