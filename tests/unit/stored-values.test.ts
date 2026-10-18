import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { SelectField } from "@/components/forms/field";
import type { Database } from "@/db";
import { businessProfiles, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { businessProfileInputFor, saveBusinessProfile, voiceEditInputFor } from "@/server/profile";
import { orStored, unknownStored } from "@/server/stored-value-rules";
import { z } from "zod";
import { createTestDb } from "../support/db";

/**
 * Check 30 P3: a value newer code stored in the shared database (a trade this code doesn't
 * list) survives a save from this code's form, and nothing else unknown gets through.
 */

const options = [
  { value: "carpentry", label: "Carpentry" },
  { value: "plumbing", label: "Plumbing" },
];

const render = (defaultValue: string | null) =>
  renderToStaticMarkup(
    createElement(SelectField, { name: "trade", label: "Trade", options, defaultValue }),
  );

describe("SelectField keeps a value it doesn't know", () => {
  it("adds a selected 'Current: …' option for an unknown stored value", () => {
    const html = render("masonry");
    expect(html).toContain('<option value="masonry" selected="">Current: masonry</option>');
    // Nothing else is selected, so the browser posts "masonry", not "carpentry".
    expect(html.match(/selected=""/g)).toHaveLength(1);
  });

  it("adds nothing for a known value, an empty value or none", () => {
    for (const v of ["plumbing", "", null]) expect(render(v)).not.toContain("Current:");
    expect(render("plumbing")).toContain('<option value="plumbing" selected="">Plumbing</option>');
  });
});

describe("orStored", () => {
  const field = z.enum(["a", "b"]);
  it("accepts the stored unknown value, still refuses other unknown ones", () => {
    const s = orStored(field, "c");
    expect(s.safeParse("c").success).toBe(true);
    expect(s.safeParse("a").success).toBe(true);
    expect(s.safeParse("d").success).toBe(false);
  });
  it("is the plain field when the stored value is known or empty", () => {
    expect(orStored(field, "a")).toBe(field);
    expect(orStored(field, "")).toBe(field);
    expect(orStored(field, null)).toBe(field);
  });
  it("unknownStored keeps only values the list doesn't have", () => {
    expect(unknownStored(["a", "x", "b", "y"], ["a", "b"])).toEqual(["x", "y"]);
    expect(unknownStored(null, ["a"])).toEqual([]);
  });
});

describe("saving Settings with a trade this code doesn't know", () => {
  let database: Database;
  beforeEach(async () => {
    database = await createTestDb();
    // Newer code added the value to the shared database's enum.
    await database.execute(sql`alter type trade add value if not exists 'masonry'`);
  });

  const form = {
    businessName: "Stone & Sons",
    services: "Walls, steps, chimneys",
    serviceArea: "",
    hours: "",
    leadTime: "",
    pricingNotes: "",
    paymentTerms: "",
    policies: "",
    signature: "",
    doNotPromise: "",
    vipSenders: "",
    amountThresholdDollars: "2500",
  };

  it("keeps the stored trade, extra trades and state when posted back unchanged", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@stone.com" });
    await database.execute(
      sql`update workspaces set trade = 'masonry', extra_trades = array['tiling', 'plumbing'] where id = ${workspace.id}`,
    );
    await database
      .insert(businessProfiles)
      .values({ workspaceId: workspace.id, state: "PR" })
      .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { state: "PR" } });

    const schema = businessProfileInputFor({ trade: "masonry", state: "PR" });
    const parsed = schema.safeParse({
      ...form,
      trade: "masonry",
      state: "PR",
      extraTrades: "carpentry",
    });
    expect(parsed.success).toBe(true);
    await saveBusinessProfile(workspace.id, parsed.data!);

    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(w!.trade).toBe("masonry");
    // "tiling" had no box on this form, so it stays; "plumbing" was unticked.
    expect(w!.extraTrades).toEqual(["tiling", "carpentry"]);
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspace.id));
    expect(p!.state).toBe("PR");
  });

  it("still refuses an unknown trade or state that isn't the stored one", () => {
    const schema = businessProfileInputFor({ trade: "masonry", state: "PR" });
    expect(schema.safeParse({ ...form, trade: "welding" }).success).toBe(false);
    expect(schema.safeParse({ ...form, trade: "carpentry", state: "ZZ" }).success).toBe(false);
    // Without a stored unknown value the plain rules apply.
    expect(
      businessProfileInputFor({ trade: "carpentry" }).safeParse({ ...form, trade: "masonry" })
        .success,
    ).toBe(false);
  });

  it("keeps a stored formality the voice form doesn't list", () => {
    const voice = {
      greetingStyle: "Hi",
      signoffStyle: "Thanks",
      avgLengthWords: "60",
      phrasesUsed: "",
      phrasesAvoided: "",
      summary: "",
    };
    expect(
      voiceEditInputFor({ formality: "playful" }).safeParse({ ...voice, formality: "playful" })
        .success,
    ).toBe(true);
    expect(
      voiceEditInputFor({ formality: "playful" }).safeParse({ ...voice, formality: "grumpy" })
        .success,
    ).toBe(false);
  });
});
