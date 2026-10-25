import "server-only";
import { and, eq, exists, isNull, lte, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { planHasAutopilot } from "@/config/pricing";
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
import { signOutEverywhere } from "./sign-out-everywhere";
import {
  canMakeMove,
  effectiveStatus,
  EVALUATION_MS,
  resumeTarget,
  type AdminMove,
} from "./lifecycle";
import { effectivePlan } from "./referral-rules";
import { fitMailboxesToPlan } from "./mailbox-plan";
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
  // Check 26 P3: not a status move. Ends the owner's sign-ins; the status stays as it is.
  if (move === "sign_out_everywhere") {
    await signOutEverywhere(workspaceId, "admin");
    return w.status;
  }

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
      // Check 17 P1: remember where it stood, so Resume can't skip past a failed payment.
      set = { status: "paused", pausedFrom: effectiveStatus(w, now) };
      break;
    case "resume":
      set = { status: resumeTarget(w, now), pausedFrom: null };
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

/**
 * Check 17 P6: what a plan change does, wherever it comes from (/admin or Stripe's billing
 * page). Call it after the new plan is written (in the same transaction when there is one):
 * the plan effects are `autopilotPlanEffects` (plan #47: the plan that counts decides, so a
 * running free month keeps autopilot), and one content-free `plan_changed` row says who
 * changed it when the plan moved. The Gmail limit is fitted separately (`fitMailboxesToPlan`).
 */
export async function applyPlanChange(
  workspaceId: string,
  from: Workspace["plan"],
  to: Workspace["plan"],
  by: "admin" | "stripe",
  now: Date = new Date(),
  executor: Executor = db(),
) {
  await autopilotPlanEffects(workspaceId, now, executor);
  if (from === to) return;
  await executor.insert(activityLog).values({
    workspaceId,
    actor: "squared_away",
    action: "plan_changed",
    detail: { by, from, to },
    createdAt: now,
  });
}

/** Check 17 P7: the account has a Stripe subscription, so Stripe decides its plan. */
export class PlanSetByStripeError extends Error {
  constructor() {
    super("This account's plan is set by its Stripe subscription.");
    this.name = "PlanSetByStripeError";
  }
}

/**
 * Davi sets the plan by hand until Stripe does (Milestone 10). The plan
 * decides mailbox limits and whether autopilot can be unlocked. Dropping to a
 * plan without autopilot switches it off and stops anything counting down
 * (autopilotPlanEffects, the same code every plan path runs); `fitMailboxesToPlan`
 * pauses or turns back on Gmail addresses for the plan that counts.
 */
export async function setWorkspacePlan(
  workspaceId: string,
  plan: Workspace["plan"],
  now: Date = new Date(),
) {
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w) throw new Error("Workspace not found.");
  // Check 17 P7: never a plan that disagrees with what Stripe charges (and that its next
  // subscription event would quietly put back). The update re-checks it too.
  if (w.stripeSubscriptionId) throw new PlanSetByStripeError();
  const [row] = await db()
    .update(workspaces)
    .set({ plan })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.stripeSubscriptionId)))
    .returning({ id: workspaces.id });
  if (!row) throw new PlanSetByStripeError();
  await applyPlanChange(workspaceId, w.plan, plan, "admin", now);
  // A plan covering fewer Gmail addresses pauses the extra ones; a bigger one turns them back
  // on (Davi, 2026-10-16).
  await fitMailboxesToPlan(workspaceId, now);
}
