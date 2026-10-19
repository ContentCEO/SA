import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v6";
import { tradePromptFor, tradePrompts } from "@/ai/prompts/trades";
import { sql } from "drizzle-orm";
import { cleanExtraTrades, TRADES, tradeLabel } from "@/config/trades";
import { jobKindOf } from "@/server/monthly-rules";
import { createTestDb } from "../support/db";
import { tradeEnum } from "@/db/schema";

describe("trades", () => {
  it("the database enum is the config list", () => {
    expect([...tradeEnum.enumValues]).toEqual([...TRADES]);
    expect(TRADES).toEqual(expect.arrayContaining(["hvac", "roofing", "painting", "landscaping"]));
    expect(TRADES.at(-1)).toBe("other");
  });

  it.each(TRADES)("%s has its own prompt file with words and quote questions", (t) => {
    expect(existsSync(`src/ai/prompts/trades/${t}.ts`)).toBe(true);
    expect(tradePrompts[t].vocabulary.length).toBeGreaterThanOrEqual(5);
    expect(tradePrompts[t].quoteQuestions.length).toBeGreaterThanOrEqual(4);
    expect(tradePrompts[t].quoteQuestions[0]).toMatch(/address/);
    expect(tradeLabel[t]).toBeTruthy();
  });

  it("no trade file asks the customer whether a permit is needed (Check 36 P8 + 37 P4 + 41 P4)", () => {
    for (const t of TRADES)
      for (const q of tradePrompts[t].quoteQuestions)
        expect(q, `${t}: ${q}`).not.toMatch(/permit/i);
  });

  it("the plumbing, electrical and HVAC words and questions (Check 36 P8 + 37 P4 + 39 P6)", () => {
    const block = (trade: string) =>
      workspaceBlock({
        businessName: null,
        trade,
        services: null,
        serviceArea: null,
        hours: null,
        leadTime: null,
        pricingNotes: null,
        paymentTerms: null,
        policies: null,
        signature: null,
        doNotPromise: [],
        neverSay: [],
        seasonalNotes: [],
        voice: null,
      });
    const plumbing = block("plumbing");
    for (const w of [
      "expansion tank",
      "T&P valve",
      "RPZ / backflow test",
      "heat pump water heater",
      "town water or a well",
      "who approves and pays",
      "photo of the vent pipe",
    ])
      expect(plumbing).toContain(w);
    expect(plumbing).not.toContain("whether a permit is involved");
    const electrical = block("electrical");
    for (const w of [
      "Inspector of Wires",
      "cut and reconnect",
      "meter socket / meter-main",
      "the town the job is in",
      "for EV chargers",
      "for service upgrades",
      "can't lose power",
    ])
      expect(electrical).toContain(w);
    expect(electrical).not.toContain("whether a permit or inspection is involved");
    const hvac = block("hvac");
    for (const w of [
      "boiler (oil or gas)",
      "backup heat / dual fuel",
      "ENERGY STAR Cold Climate",
      "R-454B",
      "how many zones",
      "home energy assessment",
      "main electric panel size",
    ])
      expect(hvac).toContain(w);
    expect(hvac).not.toContain("size of the home in square feet");
    // Massachusetts program names only for Massachusetts shops (Check 44 P1 + 45 P2).
    expect(hvac).not.toContain("Mass Save");
    expect(plumbing).not.toContain("Mass Save");
  });

  it("Check 41 P3: a landscaping + snow shop's block lists the snow questions; the enum has 'snow'", async () => {
    const block = workspaceBlock({
      businessName: null,
      trade: "landscaping",
      extraTrades: ["snow"],
      services: null,
      serviceArea: null,
      hours: null,
      leadTime: null,
      pricingNotes: null,
      paymentTerms: null,
      policies: null,
      signature: null,
      doNotPromise: [],
      neverSay: [],
      seasonalNotes: [],
      voice: null,
    });
    expect(block).toContain("landscaping and snow plowing");
    expect(block).toContain("driveway length and width, paved or gravel");
    expect(block).toContain("per push or a season price");
    expect(block).toContain("trigger depth");
    expect(tradeLabel.snow).toBe("Snow plowing");
    expect(TRADES.indexOf("snow")).toBe(TRADES.length - 2);
    expect(jobKindOf("snow", "plow the driveway and salt the walk")).toBe("Plowing");
    expect(jobKindOf("snow", "salt the walk")).toBe("Salting and sanding");
    expect(jobKindOf("snow", "roof rake after the storm")).toBe("Roof snow");
    // Landscaping keeps its own label, so threads filed under it keep it.
    expect(jobKindOf("landscaping", "plow the driveway")).toBe("Snow and plowing");
    expect(cleanExtraTrades(["snow"], "landscaping")).toEqual(["snow"]);
    // The real migrations (PGlite) add the enum value.
    const db = await createTestDb();
    const rows = await db.execute(sql`select unnest(enum_range(null::trade))::text as v`);
    const values =
      (rows as unknown as { rows?: { v: string }[] }).rows ?? (rows as unknown as { v: string }[]);
    expect(values.map((r) => r.v)).toContain("snow");
  });

  it("drafts get the owner's trade questions; unknown trades fall back safely", () => {
    const ctx = {
      businessName: null,
      trade: "roofing",
      services: null,
      serviceArea: null,
      hours: null,
      leadTime: null,
      pricingNotes: null,
      paymentTerms: null,
      policies: null,
      signature: null,
      doNotPromise: [],
      neverSay: [],
      seasonalNotes: [],
      voice: null,
    } satisfies WorkspaceContext;
    const block = workspaceBlock(ctx);
    expect(block).toContain("tear-off vs. layover");
    expect(block).toContain("whether insurance is involved");
    expect(block).not.toContain("panel");
    expect(tradePromptFor(null)).toBe(tradePrompts.other);
    expect(tradePromptFor("blacksmith")).toBe(tradePrompts.other);
  });
});
