import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pricing } from "@/config/pricing";
import { PLAN_IDS } from "@/server/billing-rules";
import {
  autopilotPlanNames,
  FEATURED_PLAN,
  planFeatureLines,
  SHARED_PLAN_LINE,
} from "@/server/plan-features";

/** Check 35 P4: one list of what each plan includes, chosen by id, from the config. */
describe("plan feature lines", () => {
  it("match the config: inbox count, the shared line, autopilot only where the plan has it", () => {
    for (const id of PLAN_IDS) {
      const p = pricing.plans[id];
      const lines = planFeatureLines(id);
      expect(lines[0]).toMatch(new RegExp(`^${p.mailboxLimit} Gmail inbox(es)?\\b`));
      expect(lines).toContain(SHARED_PLAN_LINE);
      expect(lines.includes("Autopilot for the emails you choose")).toBe(p.autopilot);
    }
    expect(planFeatureLines("company")).toContain("Priority support");
    expect(planFeatureLines("solo")).not.toContain("Priority support");
    expect(PLAN_IDS).toContain(FEATURED_PLAN);
  });

  it("autopilotPlanNames names the plans with autopilot", () => {
    const names = Object.values(pricing.plans)
      .filter((p) => p.autopilot)
      .map((p) => p.name);
    expect(autopilotPlanNames()).toBe(
      `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
    );
  });

  it("no page decides anything by a plan's display name", () => {
    for (const f of [
      "src/app/page.tsx",
      "src/components/marketing/plan-cards.tsx",
      "src/app/(app)/billing/page.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\.name === "/);
      expect(src, f).not.toMatch(/=== "(crew|company|solo)"/);
    }
    expect(readFileSync("src/server/autopilot.ts", "utf8")).not.toContain("Crew and Company");
  });

  it("both pages use the same lines", () => {
    expect(readFileSync("src/components/marketing/plan-cards.tsx", "utf8")).toContain(
      "planFeatureLines(id)",
    );
    expect(readFileSync("src/app/(app)/billing/page.tsx", "utf8")).toContain(
      "planFeatureLines(id)",
    );
  });
});
