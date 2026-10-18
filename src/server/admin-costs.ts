import "server-only";
import { and, eq, gte, sql, sum } from "drizzle-orm";
import { utcDay } from "@/ai/usage";
import { dailyAiCallCap } from "@/config/models";
import { formatDollars, type PlanId } from "@/config/pricing";
import { db } from "@/db";
import { appSettings, usage, users, workspaces, type Workspace } from "@/db/schema";
import { effectiveStatus } from "./lifecycle";
import { sendEmail, type EmailSender } from "@/lib/email";
import { appUrl } from "@/lib/app-url";
import { COST_ALERT_SHARE, costAlertDue, costLine } from "./admin-cost-rules";
import { freeMonthRunning } from "./referral-rules";

export type CostRow = {
  workspaceId: string;
  /** The owner's own business name / sign-in email — never anything from their customers. */
  label: string;
  status: Workspace["status"];
  /** Davi's own house account (pays nothing). */
  house: boolean;
  plan: PlanId | null;
  /** Plan #47: a free referral month is running (revenue stays the billed price). */
  freeMonth: boolean;
  costCents: number;
  revenueCents: number;
  marginCents: number;
  feesCents: number;
  marginAfterFeesCents: number;
  costShare: number | null;
  calls: number;
  busiestDayCalls: number;
  cap: number;
  alert: boolean;
};

/** Plan #45: this month, per account, worst margin first. Counts and money only. */
export async function costRows(now: Date = new Date()): Promise<CostRow[]> {
  const monthStart = `${utcDay(now).slice(0, 7)}-01`;
  const per = db()
    .select({
      workspaceId: usage.workspaceId,
      calls: sum(usage.aiCalls).mapWith(Number).as("calls"),
      cost: sum(usage.estimatedCostCentiCents).mapWith(Number).as("cost"),
      busiest: sql<number>`max(${usage.aiCalls})::int`.as("busiest"),
    })
    .from(usage)
    .where(gte(usage.period, monthStart))
    .groupBy(usage.workspaceId)
    .as("per");
  const rows = await db()
    .select({
      workspaceId: workspaces.id,
      businessName: workspaces.businessName,
      email: users.email,
      status: workspaces.status,
      evaluationEndsAt: workspaces.evaluationEndsAt,
      setupPaidVia: workspaces.setupPaidVia,
      plan: workspaces.plan,
      freePlan: workspaces.freePlan,
      freePlanUntil: workspaces.freePlanUntil,
      calls: per.calls,
      cost: per.cost,
      busiest: per.busiest,
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(per, eq(per.workspaceId, workspaces.id));
  const cap = dailyAiCallCap();
  return rows
    .map((r) => {
      // Check 16 P10: the same status /admin shows (an expired trial isn't "evaluating").
      const status = effectiveStatus(r, now);
      const input = {
        status,
        plan: r.plan,
        costCentiCents: r.cost ?? 0,
        setupPaidVia: r.setupPaidVia,
      };
      return {
        workspaceId: r.workspaceId,
        label: r.businessName || r.email,
        status,
        house: r.setupPaidVia === "house",
        plan: r.plan,
        freeMonth: freeMonthRunning(r, now),
        ...costLine(input),
        calls: r.calls ?? 0,
        busiestDayCalls: r.busiest ?? 0,
        cap,
        alert: costAlertDue(input),
      };
    })
    .sort((a, b) => a.marginCents - b.marginCents || b.costCents - a.costCents);
}

/**
 * Daily: email Davi once per account per month when its AI cost passes 40% of
 * its plan price. Money and the owner's business name only.
 */
export async function sendCostAlerts(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<{ sent: number; failed: number }> {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return { sent: 0, failed: 0 };
  const send = deps.send ?? sendEmail;
  const month = utcDay(now).slice(0, 7);
  let sent = 0;
  let failed = 0;
  for (const r of (await costRows(now)).filter((x) => x.alert)) {
    const key = `cost_alert:${r.workspaceId}:${month}`;
    // Check 18 P1: one refused email never stops the next account's alert or the purge steps
    // after this one. Nothing is marked, so tomorrow's run tries again. Ids and error names only.
    try {
      const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, key));
      if (seen) continue;
      const share = Math.round((r.costShare ?? 0) * 100);
      const text = [
        `${r.label}: AI cost this month is ${formatDollars(r.costCents)}, ${share}% of their ${formatDollars(r.revenueCents)} plan (alert line: ${Math.round(COST_ALERT_SHARE * 100)}%).`,
        `Margin so far: ${formatDollars(r.marginCents)}. Busiest day: ${r.busiestDayCalls} of ${r.cap} calls.`,
        `See ${appUrl("/admin/costs")}`,
      ].join("\n\n");
      const result = await send({
        to,
        subject: `AI cost alert: ${r.label} at ${share}% of plan`,
        text,
        html: text
          .split("\n\n")
          .map(
            (p) =>
              `<p>${p.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</p>`,
          )
          .join(""),
        idempotencyKey: `cost-${r.workspaceId}-${month}`,
      });
      // "already_sent": an earlier try this month got through but its marker didn't save.
      if (result === "not_configured") return { sent, failed };
      await db()
        .insert(appSettings)
        .values({ key, value: now.toISOString() })
        .onConflictDoNothing();
      sent++;
    } catch (err) {
      failed++;
      console.error("cost_alert_failed", {
        workspaceId: r.workspaceId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { sent, failed };
}

/** Old alert markers aren't needed once their month is over. */
export async function purgeCostAlertMarkers(now: Date = new Date()) {
  const month = utcDay(now).slice(0, 7);
  await db()
    .delete(appSettings)
    .where(
      and(
        sql`${appSettings.key} like 'cost_alert:%'`,
        sql`right(${appSettings.key}, 7) < ${month}`,
      ),
    );
}
