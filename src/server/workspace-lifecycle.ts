import "server-only";
import { and, eq, exists, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { pricing } from "@/config/pricing";
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
  return row.status;
}

/**
 * Davi sets the plan by hand until Stripe does (Milestone 10). The plan
 * decides mailbox limits and whether autopilot can be unlocked. Dropping to a
 * plan without autopilot switches it off and stops anything counting down.
 */
export async function setWorkspacePlan(
  workspaceId: string,
  plan: Workspace["plan"],
  now: Date = new Date(),
) {
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w) throw new Error("Workspace not found.");
  await db().update(workspaces).set({ plan }).where(eq(workspaces.id, workspaceId));
  if (!plan || !pricing.plans[plan].autopilot) {
    await db()
      .update(rules)
      .set({ mode: "draft", updatedAt: now })
      .where(eq(rules.workspaceId, workspaceId));
    await db().execute(sql`
      update ${drafts} set auto_send_at = null
      where ${drafts.autoSendAt} is not null and ${drafts.status} = 'pending'
        and ${drafts.mailboxId} in (
          select ${mailboxes.id} from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaceId}
        )`);
  }
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "plan_changed",
      detail: { by: "admin", from: w.plan, to: plan },
    });
}
