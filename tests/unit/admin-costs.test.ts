import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { usage, workspaces } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { costAlertDue, costLine, planRevenueCents } from "@/server/admin-cost-rules";
import { costRows, sendCostAlerts } from "@/server/admin-costs";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-11T12:00:00Z");

describe("#45 admin costs", () => {
  it("revenue only from paying plans; the alert line is 40% of the plan price", () => {
    expect(planRevenueCents({ status: "active", plan: "solo" })).toBe(9_900);
    expect(planRevenueCents({ status: "evaluating", plan: "solo" })).toBe(0);
    expect(planRevenueCents({ status: "active", plan: null })).toBe(0);
    // $39.60 is exactly 40% of $99 — not over.
    expect(costAlertDue({ status: "active", plan: "solo", costCentiCents: 396_000 })).toBe(false);
    expect(costAlertDue({ status: "active", plan: "solo", costCentiCents: 396_100 })).toBe(true);
    // A trial has no price to compare with.
    expect(costAlertDue({ status: "evaluating", plan: null, costCentiCents: 9_999_999 })).toBe(
      false,
    );
    expect(costLine({ status: "active", plan: "crew", costCentiCents: 250_000 })).toEqual({
      costCents: 2_500,
      revenueCents: 19_900,
      marginCents: 17_400,
      feesCents: 746,
      marginAfterFeesCents: 19_900 - 746 - 2_500,
      costShare: 2_500 / 19_900,
    });
  });

  it("Check 29 P8: Stripe's fees per monthly charge (2.9% + 30¢ + 0.7%, rounded to the cent)", () => {
    // $99 → 287.1 + 30 + 69.3 = 386.4 → 386; $199 → 746.4 → 746; $299 → 1106.4 → 1106.
    for (const [plan, fees] of [
      ["solo", 386],
      ["crew", 746],
      ["company", 1_106],
    ] as const) {
      const line = costLine({ status: "active", plan, costCentiCents: 84_000 });
      expect(line.feesCents, plan).toBe(fees);
      expect(line.marginAfterFeesCents).toBe(line.revenueCents - fees - 840);
      expect(line.marginCents).toBe(line.revenueCents - 840);
    }
    // $199 leaves $191.54 before AI.
    expect(19_900 - costLine({ status: "active", plan: "crew", costCentiCents: 0 }).feesCents).toBe(
      19_154,
    );
    // Trials and canceled accounts: no fees.
    for (const status of ["evaluating", "canceled", "evaluation_expired"]) {
      expect(costLine({ status, plan: "crew", costCentiCents: 84_000 }).feesCents).toBe(0);
    }
    // The alert fires exactly as before (against the plan price, not after fees).
    expect(costAlertDue({ status: "active", plan: "solo", costCentiCents: 396_000 })).toBe(false);
    expect(costAlertDue({ status: "active", plan: "solo", costCentiCents: 396_100 })).toBe(true);
  });

  it("Check 16 P10: Davi's house account pays nothing and never alerts", () => {
    expect(planRevenueCents({ status: "active", plan: "crew", setupPaidVia: "house" })).toBe(0);
    expect(
      costAlertDue({
        status: "active",
        plan: "crew",
        costCentiCents: 9_999_999,
        setupPaidVia: "house",
      }),
    ).toBe(false);
    expect(planRevenueCents({ status: "active", plan: "crew", setupPaidVia: "stripe" })).toBe(
      19_900,
    );
  });

  describe("in the database", () => {
    let database: Database;
    let cheap: string;
    let dear: string;
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail) => {
      sent.push(e);
      return "sent" as const;
    };

    beforeEach(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.ADMIN_EMAIL = "davi@example.com";
      sent.length = 0;
      database = await createTestDb();
      cheap = (await ensureUserAndWorkspace({ email: "cheap@shop.com" })).workspace.id;
      dear = (await ensureUserAndWorkspace({ email: "dear@shop.com" })).workspace.id;
      await database
        .update(workspaces)
        .set({ status: "active", plan: "solo", businessName: "Dear Plumbing" })
        .where(eq(workspaces.id, dear));
      await database
        .update(workspaces)
        .set({ status: "active", plan: "crew" })
        .where(eq(workspaces.id, cheap));
      await database.insert(usage).values([
        { workspaceId: dear, period: "2026-10-02", aiCalls: 300, estimatedCostCentiCents: 300_000 },
        { workspaceId: dear, period: "2026-10-03", aiCalls: 150, estimatedCostCentiCents: 200_000 },
        // Last month doesn't count.
        {
          workspaceId: dear,
          period: "2026-09-30",
          aiCalls: 999,
          estimatedCostCentiCents: 9_000_000,
        },
        { workspaceId: cheap, period: "2026-10-05", aiCalls: 20, estimatedCostCentiCents: 5_000 },
      ]);
    });

    it("worst margin first, this month only, money and counts only", async () => {
      const rows = await costRows(NOW);
      expect(rows.map((r) => r.workspaceId).slice(0, 2)).toEqual([dear, cheap]);
      expect(rows[0]).toMatchObject({
        label: "Dear Plumbing",
        costCents: 5_000,
        revenueCents: 9_900,
        marginCents: 4_900,
        calls: 450,
        busiestDayCalls: 300,
        alert: true,
      });
      expect(rows[1]!.label).toBe("cheap@shop.com");
    });

    it("plan #47: a running free month is tagged; revenue stays the billed plan", async () => {
      await database
        .update(workspaces)
        .set({ freePlan: "crew", freePlanUntil: new Date(NOW.getTime() + 86_400_000) })
        .where(eq(workspaces.id, dear));
      const rows = await costRows(NOW);
      const row = rows.find((r) => r.workspaceId === dear)!;
      expect(row).toMatchObject({ freeMonth: true, revenueCents: 9_900 });
      expect(rows.find((r) => r.workspaceId === cheap)!.freeMonth).toBe(false);
    });

    it("Check 16 P10: a house account on Crew earns nothing; an expired trial says so", async () => {
      const house = (await ensureUserAndWorkspace({ email: "davi@example.com" })).workspace.id;
      const trial = (await ensureUserAndWorkspace({ email: "trial@shop.com" })).workspace.id;
      await database
        .update(workspaces)
        .set({ status: "active", plan: "crew", setupPaidVia: "house" })
        .where(eq(workspaces.id, house));
      await database
        .update(workspaces)
        .set({ status: "evaluating", evaluationEndsAt: new Date(NOW.getTime() - 86_400_000) })
        .where(eq(workspaces.id, trial));
      await database.insert(usage).values({
        workspaceId: house,
        period: "2026-10-04",
        aiCalls: 900,
        estimatedCostCentiCents: 9_000_000,
      });
      const rows = await costRows(NOW);
      const h = rows.find((r) => r.workspaceId === house)!;
      expect(h).toMatchObject({ revenueCents: 0, feesCents: 0, alert: false, house: true });
      expect(rows.find((r) => r.workspaceId === trial)!.status).toBe("evaluation_expired");
      const revenue = rows.reduce((t, r) => t + r.revenueCents, 0);
      expect(revenue).toBe(9_900 + 19_900);
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 1, failed: 0 });
      expect(sent[0]!.subject).toContain("Dear Plumbing");
    });

    it("emails Davi once per account per month", async () => {
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 1, failed: 0 });
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 0, failed: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("davi@example.com");
      expect(sent[0]!.subject).toBe("AI cost alert: Dear Plumbing at 51% of plan");
      expect(sent[0]!.idempotencyKey).toBe(`cost-${dear}-2026-10`);
      // Next month it may alert again.
      await database.insert(usage).values({
        workspaceId: dear,
        period: "2026-11-01",
        aiCalls: 1,
        estimatedCostCentiCents: 500_000,
      });
      expect(await sendCostAlerts(new Date("2026-11-02T12:00:00Z"), { send })).toEqual({
        sent: 1,
        failed: 0,
      });
    });

    it("Check 18 P1: one refused alert doesn't stop the next account's; it's retried next run", async () => {
      // Make the cheap account over the line too.
      await database.insert(usage).values({
        workspaceId: cheap,
        period: "2026-10-06",
        aiCalls: 5,
        estimatedCostCentiCents: 900_000,
      });
      const subjects: string[] = [];
      const orig = console.error;
      const errors: unknown[][] = [];
      console.error = (...a: unknown[]) => void errors.push(a);
      let first;
      let refusedSubject = "";
      try {
        let calls = 0;
        first = await sendCostAlerts(NOW, {
          send: async (e) => {
            if (calls++ === 0) {
              refusedSubject = e.subject;
              throw new Error("Resend 403.");
            }
            subjects.push(e.subject);
            return "sent" as const;
          },
        });
      } finally {
        console.error = orig;
      }
      expect(first).toEqual({ sent: 1, failed: 1 });
      expect(subjects).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]![0]).toBe("cost_alert_failed");
      expect(Object.keys(errors[0]![1] as object).sort()).toEqual(["error", "workspaceId"]);
      // Next run: only the refused one goes again.
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 1, failed: 0 });
      expect(sent.map((e) => e.subject)).toEqual([refusedSubject]);
    });

    it("an alert Resend says it already sent (changed body, same key) is marked, not retried daily", async () => {
      const calls: string[] = [];
      const already = async (e: OutgoingEmail) => {
        calls.push(e.idempotencyKey);
        return "already_sent" as const;
      };
      await sendCostAlerts(NOW, { send: already });
      await sendCostAlerts(NOW, { send: already });
      expect(calls).toEqual([`cost-${dear}-2026-10`]);
    });
  });
});
