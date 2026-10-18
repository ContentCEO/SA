import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { planName, PLAN_SET_BY_STRIPE_LINE } from "@/server/admin-rules";
import { pricing } from "@/config/pricing";
import { createTestDb } from "../support/db";

/** Check 17 P7: /admin can't set a plan that disagrees with Stripe. Server-side, not just hidden. */
vi.mock("@/server/session", () => ({ requireAdmin: async () => ({}) }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
const { setPlanAction } = await import("@/app/(app)/admin/actions");

const whereTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  throw new Error("no redirect");
};

let database: Database;
let workspaceId: string;
const form = (plan: string) => {
  const d = new FormData();
  d.set("workspaceId", workspaceId);
  d.set("plan", plan);
  return d;
};
const plan = async () =>
  (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!.plan;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  ({
    workspace: { id: workspaceId },
  } = await ensureUserAndWorkspace({ email: "owner@shop.com" }));
});

describe("the /admin plan picker never disagrees with Stripe (Check 17 P7)", () => {
  it("refuses for an account with a Stripe subscription", async () => {
    await database
      .update(workspaces)
      .set({
        status: "active",
        plan: "solo",
        setupPaidVia: "stripe",
        stripeSubscriptionId: "sub_1",
      })
      .where(eq(workspaces.id, workspaceId));
    expect(await whereTo(() => setPlanAction(form("company")))).toBe("/admin?error=plan_stripe");
    expect(await plan()).toBe("solo");
  });

  it("still works without one: Davi's house account and a trial", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "house" })
      .where(eq(workspaces.id, workspaceId));
    expect(await whereTo(() => setPlanAction(form("crew")))).toMatch(/^\/admin\?done=plan/);
    expect(await plan()).toBe("crew");
    await database
      .update(workspaces)
      .set({ status: "evaluating", setupPaidVia: null })
      .where(eq(workspaces.id, workspaceId));
    expect(await whereTo(() => setPlanAction(form("solo")))).toMatch(/^\/admin\?done=plan/);
    expect(await plan()).toBe("solo");
  });

  it("the card shows the Stripe line instead of the form, and plan names read properly", () => {
    expect(PLAN_SET_BY_STRIPE_LINE).toBe(
      "Plan is set by their Stripe subscription. Change it in Stripe, or they can use Manage billing.",
    );
    const page = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    const at = page.indexOf("{w.hasSubscription ? (");
    expect(at).toBeGreaterThan(-1);
    expect(page.indexOf("{PLAN_SET_BY_STRIPE_LINE}", at)).toBeLessThan(
      page.indexOf("action={setPlanAction}", at),
    );
    expect(planName("crew", pricing.plans)).toBe("Crew");
    expect(planName(null, pricing.plans)).toBe("None yet");
  });
});
