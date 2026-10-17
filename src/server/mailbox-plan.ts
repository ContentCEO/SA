import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@/db";
import { activityLog, drafts, mailboxes, workspaces } from "@/db/schema";
import { fitToPlan, mailboxLimitFor } from "./mailbox-plan-rules";
import { effectivePlan } from "./referral-rules";

/**
 * A lower plan pauses extra Gmail addresses (Davi, 2026-10-16). Rules in
 * `mailbox-plan-rules.ts`. Content-free: ids and counts only, in logs and Activity.
 */

/**
 * SQL for "this mailbox is on": Google access works and the plan covers it. Every job that
 * reads Gmail, sorts, drafts, alerts or learns uses it (or `mailboxOn` on a loaded row).
 */
export function mailboxRunning(): SQL {
  return and(eq(mailboxes.status, "active"), isNull(mailboxes.planPausedAt))!;
}

/**
 * SQL for "the plan covers this mailbox", whatever its Google access: for account-level
 * checks that count a connected address even while it needs reconnecting (the trial emails'
 * "connected Gmail" test). Anything that reads Gmail or acts uses `mailboxRunning()`.
 */
export function notPlanPaused(): SQL {
  return isNull(mailboxes.planPausedAt);
}

/** The database's transaction, or any caller's transaction these run inside. */
type Tx = Pick<Database, "select" | "update" | "insert">;

/**
 * Locks the workspace row so a plan change and a swap can't interleave. Returns how many
 * addresses the plan that counts covers: a free referral month's plan while it runs
 * (`effectivePlan`, plan #47 offer A), else the billed plan.
 */
async function lockWorkspace(tx: Tx, workspaceId: string, now: Date) {
  const [row] = await tx
    .select({
      plan: workspaces.plan,
      freePlan: workspaces.freePlan,
      freePlanUntil: workspaces.freePlanUntil,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update");
  return row ? { limit: mailboxLimitFor(effectivePlan(row, now)) } : undefined;
}

/** Paused addresses never count down to an autopilot send: those replies wait for a tap. */
async function stopCountdowns(tx: Tx, mailboxIds: string[]) {
  if (!mailboxIds.length) return;
  await tx
    .update(drafts)
    .set({ autoSendAt: null })
    .where(
      and(
        inArray(drafts.mailboxId, mailboxIds),
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
      ),
    );
}

export type FitResult = { paused: number; resumed: number };

/**
 * Makes the workspace's mailboxes fit its plan: pauses the newest of those on when there are
 * more than the plan covers, and turns paused ones back on (oldest first) when there's room.
 * Called after every plan change (admin, Stripe's webhook), a disconnect, and as a backstop
 * from the 15-minute lifecycle job. Safe to call any time; a no-op when it already fits.
 * The referral engine also calls it when a free month starts or ends, or the owner keeps the
 * higher plan, passing its own transaction (`tx`) so the plan write and the fit land together.
 */
export async function fitMailboxesToPlan(
  workspaceId: string,
  now: Date = new Date(),
  tx?: Tx,
): Promise<FitResult> {
  if (tx) return fitInside(tx, workspaceId, now);
  return db().transaction((t) => fitInside(t, workspaceId, now));
}

async function fitInside(tx: Tx, workspaceId: string, now: Date): Promise<FitResult> {
  const ws = await lockWorkspace(tx, workspaceId, now);
  if (!ws) return { paused: 0, resumed: 0 };
  const limit = ws.limit;
  const boxes = await tx
    .select({
      id: mailboxes.id,
      createdAt: mailboxes.createdAt,
      planPausedAt: mailboxes.planPausedAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  const { pause, unpause } = fitToPlan(boxes, limit);
  if (pause.length) {
    await tx
      .update(mailboxes)
      .set({ planPausedAt: now })
      .where(and(inArray(mailboxes.id, pause), isNull(mailboxes.planPausedAt)));
    await stopCountdowns(tx, pause);
  }
  if (unpause.length) {
    await tx
      .update(mailboxes)
      .set({ planPausedAt: null })
      .where(and(inArray(mailboxes.id, unpause), isNotNull(mailboxes.planPausedAt)));
  }
  if (pause.length || unpause.length) {
    await tx.insert(activityLog).values({
      workspaceId,
      actor: "squared_away",
      action: "mailboxes_fit_plan",
      detail: { paused: pause.length, resumed: unpause.length, limit },
      createdAt: now,
    });
  }
  return { paused: pause.length, resumed: unpause.length };
}

export type SwapOutcome = "swapped" | "resumed" | "not_found" | "not_paused" | "choose";

/**
 * "Use this one instead" on a paused address: it comes on and `replaceId` (one that's on) is
 * paused in its place. With room under the plan (nothing to replace), it simply comes on.
 * Re-checked here under the workspace lock: both must be this workspace's, the target must be
 * paused, the one replaced must be on, and the count on never goes over the plan.
 */
export async function swapPlanMailbox(
  workspaceId: string,
  mailboxId: string,
  replaceId: string | null,
  now: Date = new Date(),
): Promise<SwapOutcome> {
  return db().transaction(async (tx) => {
    const ws = await lockWorkspace(tx, workspaceId, now);
    if (!ws) return "not_found";
    const limit = ws.limit;
    const boxes = await tx
      .select({ id: mailboxes.id, planPausedAt: mailboxes.planPausedAt })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
      .orderBy(asc(mailboxes.createdAt));
    const target = boxes.find((b) => b.id === mailboxId);
    if (!target) return "not_found";
    if (target.planPausedAt == null) return "not_paused";
    const onCount = boxes.filter((b) => b.planPausedAt == null).length;
    if (onCount < limit) {
      await tx.update(mailboxes).set({ planPausedAt: null }).where(eq(mailboxes.id, mailboxId));
      await tx.insert(activityLog).values({
        workspaceId,
        actor: "owner",
        action: "mailbox_plan_swap",
        detail: { resumed: mailboxId, paused: null },
      });
      return "resumed";
    }
    const replaced = replaceId ? boxes.find((b) => b.id === replaceId) : undefined;
    if (!replaced || replaced.planPausedAt != null) return "choose";
    await tx.update(mailboxes).set({ planPausedAt: now }).where(eq(mailboxes.id, replaced.id));
    await stopCountdowns(tx, [replaced.id]);
    await tx.update(mailboxes).set({ planPausedAt: null }).where(eq(mailboxes.id, mailboxId));
    // The count on is unchanged by a one-for-one swap, so it can't go over the plan.
    await tx.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "mailbox_plan_swap",
      detail: { resumed: mailboxId, paused: replaced.id },
    });
    return "swapped";
  });
}

/**
 * Backstop for the 15-minute job: workspaces whose mailboxes don't fit their plan (a plan set
 * by older code, a webhook that failed half-way). Fits each one; returns how many changed.
 */
export async function fitAllMailboxesToPlans(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      plan: workspaces.plan,
      freePlan: workspaces.freePlan,
      freePlanUntil: workspaces.freePlanUntil,
      on: sql<number>`count(*) filter (where ${mailboxes.planPausedAt} is null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .groupBy(mailboxes.workspaceId, workspaces.plan, workspaces.freePlan, workspaces.freePlanUntil);
  let changed = 0;
  for (const r of rows) {
    const want = Math.min(mailboxLimitFor(effectivePlan(r, now)), Number(r.total));
    if (Number(r.on) === want) continue;
    const res = await fitMailboxesToPlan(r.workspaceId, now);
    if (res.paused || res.resumed) changed++;
  }
  return changed;
}
