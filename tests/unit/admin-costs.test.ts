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
      costShare: 2_500 / 19_900,
    });
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

    it("emails Davi once per account per month", async () => {
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 1 });
      expect(await sendCostAlerts(NOW, { send })).toEqual({ sent: 0 });
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
      expect(await sendCostAlerts(new Date("2026-11-02T12:00:00Z"), { send })).toEqual({ sent: 1 });
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
