import "server-only";
import { and, asc, eq, exists, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { mailboxLimitFor, planHasAutopilot } from "@/config/pricing";
import {
  activityLog,
  drafts,
  mailboxes,
  rules,
  users,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { isAdminEmail } from "./admin";
import { canMakeMove, EVALUATION_MS, resumeTarget, type AdminMove } from "./lifecycle";
import { effectivePlan } from "./referral-rules";
import { creditReferralSafely } from "./referrals";

/**
 * Start the three-day clock. Called when Gmail is first connected — that's
 * when the owner starts seeing value. Idempotent: only an `invited` workspace
 * moves, so reconnecting never restarts the clock.
 */
export async function startEvaluation(workspaceId: string, now: Date = new Date()) {
  const [row] = await db()
    .update(workspaces)
    .set({
      status: "evaluating",
      evaluationStartedAt: now,
      evaluationEndsAt: new Date(now.getTime() + EVALUATION_MS),
    })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, "invited")))
    .returning({ id: workspaces.id, endsAt: workspaces.evaluationEndsAt });
  if (!row) return false;
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "evaluation_started",
      detail: { endsAt: row.endsAt?.toISOString() },
    });
  return true;
}

/** Backstop for the connect path: any invited workspace that has a mailbox starts its clock. */
export async function startPendingEvaluations(now: Date = new Date()): Promise<number> {
  const due = await db()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.status, "invited"),
        exists(
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaces.id)),
        ),
      ),
    );
  let started = 0;
  for (const w of due) if (await startEvaluation(w.id, now)) started++;
  return started;
}

/**
 * Record expiries. Gates already treat a run-out clock as expired
 * (`effectiveStatus`); this writes it down and logs it once.
 */
export async function expireEvaluations(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .update(workspaces)
    .set({ status: "evaluation_expired" })
    .where(and(eq(workspaces.status, "evaluating"), lte(workspaces.evaluationEndsAt, now)))
    .returning({ id: workspaces.id });
  if (rows.length) {
    await db()
      .insert(activityLog)
      .values(
        rows.map((r) => ({
          workspaceId: r.id,
          actor: "squared_away" as const,
          action: "evaluation_expired",
          detail: {},
        })),
      );
  }
  return rows.length;
}

export class MoveNotAllowedError extends Error {
  constructor(
    public readonly move: AdminMove,
    public readonly status: Workspace["status"],
  ) {
    super(`"${move}" isn't allowed from "${status}".`);
    this.name = "MoveNotAllowedError";
  }
}

/**
 * Davi's manual moves from /admin (until Stripe webhooks drive these in
 * Milestone 10). Checked against `ADMIN_MOVES`; the update is conditional on
 * the status we read, so two clicks can't race into a bad state.
 */
export async function applyAdminMove(
  workspaceId: string,
  move: AdminMove,
  now: Date = new Date(),
): Promise<Workspace["status"]> {
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w) throw new Error("Workspace not found.");
  if (!canMakeMove(move, w, now)) throw new MoveNotAllowedError(move, w.status);

  let set: Partial<Workspace>;
  switch (move) {
    case "extend_evaluation": {
      const from = w.evaluationEndsAt && w.evaluationEndsAt > now ? w.evaluationEndsAt : now;
      set = {
        status: "evaluating",
        evaluationStartedAt: w.evaluationStartedAt ?? now,
        evaluationEndsAt: new Date(from.getTime() + EVALUATION_MS),
      };
      break;
    }
    case "house_account": {
      // Only Davi's own workspace — never a customer's, whatever the request says.
      const [owner] = await db()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, w.ownerUserId));
      if (!isAdminEmail(owner?.email)) throw new MoveNotAllowedError(move, w.status);
      set = {
        status: w.status === "active" ? "active" : "setup_paid",
        setupPaidVia: "house",
        setupPaidAt: w.setupPaidAt ?? now,
      };
      break;
    }
    case "mark_setup_call_done":
      set = { status: "active", setupCallCompletedAt: now };
      break;
    case "pause":
      set = { status: "paused" };
      break;
    case "resume":
      set = { status: resumeTarget(w, now) };
      break;
  }

  const [row] = await db()
    .update(workspaces)
    .set(set)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, w.status)))
    .returning({ status: workspaces.status });
  if (!row) throw new MoveNotAllowedError(move, w.status);

  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "workspace_status_changed",
      detail: { by: "admin", move, from: w.status, to: row.status },
    });
  // Plan #47: settle a referral the first time the account is active. Never fails the move.
  if (row.status === "active") await creditReferralSafely(workspaceId, now);
  return row.status;
}

/**
 * Stop every autopilot countdown in a workspace: those replies wait for the owner's tap instead.
 * Used when the plan or the account's payment changes. Takes a transaction when there is one.
 */
export async function clearAutopilotCountdowns(
  workspaceId: string,
  executor: Pick<Database, "execute"> = db(),
) {
  await executor.execute(sql`
    update ${drafts} set auto_send_at = null
    where ${drafts.autoSendAt} is not null and ${drafts.status} = 'pending'
      and ${drafts.mailboxId} in (
        select ${mailboxes.id} from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaceId}
      )`);
}

/** What plan effects run against: the database, or the transaction they are part of. */
type Executor = Pick<Database, "select" | "update" | "insert" | "execute">;

async function planFields(workspaceId: string, executor: Executor) {
  const [w] = await executor
    .select({
      plan: workspaces.plan,
      freePlan: workspaces.freePlan,
      freePlanUntil: workspaces.freePlanUntil,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return w;
}

/** Stop the autopilot countdowns on these inboxes: those replies wait for the owner's tap. */
export async function clearMailboxCountdowns(
  mailboxIds: string[],
  executor: Pick<Database, "update">,
) {
  if (!mailboxIds.length) return;
  await executor
    .update(drafts)
    .set({ autoSendAt: null })
    .where(
      and(
        isNotNull(drafts.autoSendAt),
        eq(drafts.status, "pending"),
        inArray(drafts.mailboxId, mailboxIds),
      ),
    );
}

/**
 * Plan #47 offer A, §3.6: when the plan that counts (`effectivePlan`) has no autopilot, every
 * category goes back to drafts and every countdown stops. Idempotent. One function for every
 * path a plan can drop by — the admin's plan change, Stripe's webhook, the end of a free month
 * and the 15-minute invariant — so the same code runs on each. Logs only when it switched
 * something off. Returns how many categories it switched off.
 */
export async function autopilotPlanEffects(
  workspaceId: string,
  now: Date = new Date(),
  executor: Executor = db(),
): Promise<number> {
  const w = await planFields(workspaceId, executor);
  if (!w || planHasAutopilot(effectivePlan(w, now))) return 0;
  const off = await executor
    .update(rules)
    .set({ mode: "draft", updatedAt: now })
    .where(and(eq(rules.workspaceId, workspaceId), eq(rules.mode, "autopilot")))
    .returning({ category: rules.category });
  await clearAutopilotCountdowns(workspaceId, executor);
  if (off.length > 0) {
    await executor.insert(activityLog).values({
      workspaceId,
      actor: "squared_away",
      action: "autopilot_turned_off_plan",
      detail: { count: off.length },
      createdAt: now,
    });
  }
  return off.length;
}

/**
 * The invariant behind autopilotPlanEffects, every 15 minutes: any workspace with a category
 * on autopilot whose plan that counts has none is switched back (and logged). Also cleans rules
 * left on by Stripe-page downgrades before this existed. Returns the workspaces it fixed.
 */
export async function enforcePlanAutopilot(now: Date = new Date()): Promise<number> {
  const candidates = await db()
    .selectDistinct({
      id: workspaces.id,
      plan: workspaces.plan,
      freePlan: workspaces.freePlan,
      freePlanUntil: workspaces.freePlanUntil,
    })
    .from(rules)
    .innerJoin(workspaces, eq(workspaces.id, rules.workspaceId))
    .where(eq(rules.mode, "autopilot"));
  let fixed = 0;
  for (const w of candidates) {
    if (planHasAutopilot(effectivePlan(w, now))) continue;
    try {
      if ((await autopilotPlanEffects(w.id, now)) > 0) fixed++;
    } catch (err) {
      console.error("enforce_plan_autopilot_failed", {
        workspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return fixed;
}

/** Inboxes that count against the plan: every one not paused for being over it, oldest first. */
async function countedInboxes(workspaceId: string, executor: Executor) {
  return executor
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), isNull(mailboxes.pausedReason)))
    .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
}

/**
 * Plan #47 offer A, §3.6 (and Davi's Q2, 2026-10-16: a move down a plan on Stripe's page too):
 * more inboxes than the plan that counts includes → the newest-created extras pause
 * (`paused`, reason `over_plan`). Ranked by `created_at`, which a reconnect never resets, so
 * the first inbox stays on. Inboxes needing a reconnect count. Nothing is deleted; their
 * countdowns stop, and a send in its undo window stops through the normal send path. Returns
 * how many it paused.
 */
export async function inboxLimitEffects(
  workspaceId: string,
  now: Date = new Date(),
  executor: Executor = db(),
): Promise<number> {
  const w = await planFields(workspaceId, executor);
  if (!w) return 0;
  const plan = effectivePlan(w, now);
  const limit = mailboxLimitFor(plan);
  const extra = (await countedInboxes(workspaceId, executor)).slice(limit).map((m) => m.id);
  if (!extra.length) return 0;
  const paused = await executor
    .update(mailboxes)
    .set({ status: "paused", pausedReason: "over_plan" })
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(mailboxes.id, extra),
        isNull(mailboxes.pausedReason),
      ),
    )
    .returning({ id: mailboxes.id });
  await clearMailboxCountdowns(
    paused.map((m) => m.id),
    executor,
  );
  if (paused.length) {
    await executor.insert(activityLog).values({
      workspaceId,
      actor: "squared_away",
      action: "inboxes_paused_plan",
      detail: { count: paused.length, plan, limit },
      createdAt: now,
    });
  }
  return paused.length;
}

/**
 * What a paused-for-the-plan inbox goes back to: one that lost Google access while it was on
 * (sync set `access_lost_at`, which only a reconnect clears) is still `reconnect_needed`, so the
 * banner and the access-lost alerts don't treat it as healthy — or tell the owner twice.
 */
export const resumedInboxStatus = sql<
  "active" | "reconnect_needed"
>`(case when ${mailboxes.accessLostAt} is not null then 'reconnect_needed' else 'active' end)::mailbox_status`;

/**
 * Wherever the limit can rise or a slot frees up (a plan change, a free month starting, Keep,
 * a disconnect): switch over-plan inboxes back on, oldest-created first, up to the limit. Only
 * ever resumes, so it changes nothing for anyone without paused inboxes. Returns how many.
 */
export async function resumeOverPlanInboxes(
  workspaceId: string,
  now: Date = new Date(),
  executor: Executor = db(),
): Promise<number> {
  const w = await planFields(workspaceId, executor);
  if (!w) return 0;
  const room =
    mailboxLimitFor(effectivePlan(w, now)) - (await countedInboxes(workspaceId, executor)).length;
  if (room <= 0) return 0;
  const waiting = await executor
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.pausedReason, "over_plan")))
    .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id))
    .limit(room);
  if (!waiting.length) return 0;
  const resumed = await executor
    .update(mailboxes)
    .set({ status: resumedInboxStatus, pausedReason: null })
    .where(
      and(
        inArray(
          mailboxes.id,
          waiting.map((m) => m.id),
        ),
        eq(mailboxes.pausedReason, "over_plan"),
      ),
    )
    .returning({ id: mailboxes.id });
  if (resumed.length) {
    await executor.insert(activityLog).values({
      workspaceId,
      actor: "squared_away",
      action: "inboxes_resumed_plan",
      detail: { count: resumed.length },
      createdAt: now,
    });
  }
  return resumed.length;
}

/**
 * Davi sets the plan by hand until Stripe does (Milestone 10). The plan
 * decides mailbox limits and whether autopilot can be unlocked. Dropping to a
 * plan without autopilot switches it off and stops anything counting down
 * (autopilotPlanEffects, the same code every plan path runs); a plan with room
 * switches paused over-plan inboxes back on.
 */
export async function setWorkspacePlan(
  workspaceId: string,
  plan: Workspace["plan"],
  now: Date = new Date(),
) {
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w) throw new Error("Workspace not found.");
  await db().update(workspaces).set({ plan }).where(eq(workspaces.id, workspaceId));
  await autopilotPlanEffects(workspaceId, now);
  await resumeOverPlanInboxes(workspaceId, now);
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "plan_changed",
      detail: { by: "admin", from: w.plan, to: plan },
    });
}
