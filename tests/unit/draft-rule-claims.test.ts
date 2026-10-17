import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft, REGENERATE_ON } from "@/ai/draft-checks";
import type { ModelDraft } from "@/ai/prompts/draft.v6";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const RULE_FLAG =
  "Says something about a rebate, tax credit or refrigerant rule. Check it's still true before sending.";
const ctx = (sourceText: string, owner = "") => ({
  sourceText: `${sourceText}\n${owner}`,
  ownerSourceText: owner,
  doNotPromise: [],
  phrasesAvoided: [],
});

describe("rebate, tax-credit and refrigerant rules (Check 39 P4)", () => {
  const credit = "Yes, the $2,000 federal tax credit still applies to heat pumps.";
  const freon = "R-22 is still legal to use, but it's expensive now since it's no longer made.";

  it("both review drafts get the flag, with no extra model call", () => {
    const a = checkDraft(credit, ctx("Is the $2,000 federal tax credit still around?"));
    expect(a.flags).toContain(RULE_FLAG);
    expect(a.hits).toContain("rule_claim");
    const b = checkDraft(freon, ctx("Can you just add freon?"));
    expect(b.flags).toContain(RULE_FLAG);
    expect(b.confidenceCap).toBeLessThanOrEqual(0.5);
    expect(REGENERATE_ON).not.toContain("rule_claim");
  });

  it("what the owner wrote themselves passes", () => {
    const owner = "The federal heat pump credit ended for systems installed after 2025. $2,000";
    expect(checkDraft(credit, ctx("Is the credit still around?", owner)).hits).not.toContain(
      "rule_claim",
    );
    expect(
      checkDraft(
        "We'll check for a refrigerant leak first.",
        ctx("The AC blows warm.", "Services: AC repair, refrigerant leak checks"),
      ).hits,
    ).not.toContain("rule_claim");
  });

  it("a draft with none of the words is unchanged, and a credit card isn't a credit", () => {
    expect(checkDraft("Happy to take a look. What's the address?", ctx("AC is out")).hits).toEqual(
      [],
    );
    expect(checkDraft("Pay by credit card on the day.", ctx("x")).hits).not.toContain("rule_claim");
  });
});

describe("rebate promises (Check 37 P5)", () => {
  const promise =
    "Eversource covers the whole wiring cost for most people, so you'll likely pay nothing for that part.";
  it("a promise that the utility or a rebate pays is a soft promise", () => {
    const r = checkDraft(promise, ctx("How much for a Level 2 charger?"));
    expect(r.hits).toContain("soft_promise");
    expect(r.flags.join(" ")).toContain("“a rebate or utility will pay”");
    expect(checkDraft("You'll definitely qualify for the rebate.", ctx("x")).hits).toContain(
      "soft_promise",
    );
  });
  it("pointing them to the program isn't; the owner's own line lets it pass", () => {
    expect(
      checkDraft(
        "Eversource offers rebates on the wiring for some chargers; you apply on their site.",
        ctx("x"),
      ).hits,
    ).not.toContain("soft_promise");
    expect(checkDraft(promise, ctx("x", promise)).hits).not.toContain("soft_promise");
  });
});

describe("the rule flag reaches the stored draft (Check 39 P4)", () => {
  it("is on the card, from one model call", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe", trade: "hvac" })
      .where(eq(workspaces.id, workspace.id));
    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const now = new Date("2026-10-10T16:00:00Z");
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId: box.id,
        gmailThreadId: "t1",
        inInbox: true,
        subject: "AC",
        category: "customer_question",
        classifiedAt: now,
        lastMessageAt: now,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: box.id,
      gmailMessageId: "m1",
      rfc822MessageId: "<m1@x.com>",
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana",
      subject: "AC",
      bodyText: "Our old AC is low. Can you just add freon?",
      sentAt: new Date(now.getTime() - 3600_000),
    });
    const d: ModelDraft = {
      body: "Hi Dana, R-22 is still legal to use, but it's pricey now. What's the address?",
      reason: "Recharge question.",
      flags: [],
      confidence: 0.9,
      used_facts: [],
    };
    const { transport, calls } = fakeTransport([d]);
    setModelTransportForTests(transport);
    await createDraftForThread(t!.id, {
      trigger: "auto",
      writerFor: () => new FakeWriter(),
      now: () => now,
    });
    expect(calls).toHaveLength(1);
    const [saved] = await database.select().from(drafts);
    expect(saved!.flags).toContain(RULE_FLAG);
    expect(saved!.confidence).toBeLessThanOrEqual(50);
  });
});
