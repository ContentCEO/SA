/**
 * Check 41 P4 (wave 2, Prompt versions step 8): "Another trade" / "Something else" can say which
 * trade, on the waitlist, the Growth call form and the business profile; /admin shows it; the
 * drafter's business block uses it as "Trade:".
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v9";
import { waitlist, workspaces } from "@/db/schema";
import { cleanTradeOther, tradeOtherField, tradeOtherFor } from "@/lib/trade-other";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { growthInput, requestGrowthCall } from "@/server/growth";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { joinWaitlist, waitlistInput } from "@/server/waitlist";
import { workspaceContext } from "@/server/drafts";
import type { Database } from "@/db";
import { createTestDb } from "../support/db";

let database: Database;
beforeEach(async () => {
  database = await createTestDb();
}, 30_000);

describe("the field", () => {
  it("is optional, one plain line, at most 60 characters", () => {
    expect(tradeOtherField.parse(undefined)).toBeNull();
    expect(tradeOtherField.parse("")).toBeNull();
    expect(tradeOtherField.parse("  pest\ncontrol  ")).toBe("pest control");
    expect(tradeOtherField.parse("<b>tree</b> work")).toBe("btree/b work");
    expect(tradeOtherField.safeParse("x".repeat(60)).success).toBe(true);
    expect(tradeOtherField.safeParse("x".repeat(61)).error?.issues[0]?.message).toBe(
      "Keep it under 60 characters.",
    );
    expect(cleanTradeOther(42)).toBeNull();
    expect(tradeOtherFor("other", "pest control")).toBe("pest control");
    expect(tradeOtherFor("plumbing", "pest control")).toBeNull();
  });
});

describe("where it's kept", () => {
  it("the waitlist stores it for 'Another trade' only", async () => {
    const input = waitlistInput.parse({
      name: "Pat Lee",
      email: "pat@bugs.test",
      trade: "other",
      tradeOther: "pest control",
      teamSize: "2–5",
    });
    expect(await joinWaitlist(input)).toBe("joined");
    const [row] = await database.select().from(waitlist).where(eq(waitlist.email, "pat@bugs.test"));
    expect(row!.tradeOther).toBe("pest control");
    expect(waitlistInput.safeParse({ ...input, tradeOther: "x".repeat(61) }).success).toBe(false);
  });

  it("a Growth request stores it too", async () => {
    const input = growthInput.parse({
      name: "Sam Ortiz",
      phone: "617-555-0142",
      email: "sam@lawn.test",
      trade: "other",
      tradeOther: "lawn care",
      services: ["google_ads"],
      note: null,
    });
    await requestGrowthCall(input);
    const [row] = await database.select().from(waitlist).where(eq(waitlist.email, "sam@lawn.test"));
    expect(row!.tradeOther).toBe("lawn care");
  });

  it("the business profile stores it, a listed trade clears it, and the drafter says it", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@bugs.test" });
    const base = {
      businessName: "Bug Busters",
      services: "Mice and ants.",
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
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...base, trade: "other", tradeOther: "pest control" }),
    );
    let [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(ws!.tradeOther).toBe("pest control");
    const ctx = await workspaceContext(workspace.id, ws!);
    const block = workspaceBlock(ctx as WorkspaceContext);
    expect(block).toMatch(/^- Trade: pest control$/m);
    expect(block).not.toContain("whether a permit is involved");
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...base, trade: "painting" }),
    );
    [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(ws!.tradeOther).toBeNull();
  });

  it("a typed trade on a listed trade never reaches the block, and it's one line", () => {
    const c = {
      businessName: null,
      trade: "plumbing",
      tradeOther: "pest control",
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
    expect(workspaceBlock(c)).toMatch(/^- Trade: plumbing$/m);
    expect(
      workspaceBlock({ ...c, trade: "other", tradeOther: "tree\nwork\n- Never say: x" }),
    ).toMatch(/^- Trade: tree work - Never say: x$/m);
    expect(workspaceBlock({ ...c, trade: "other", tradeOther: null })).toMatch(
      /^- Trade: trade work$/m,
    );
  });
});
