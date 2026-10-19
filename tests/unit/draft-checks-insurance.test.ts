import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft, REGENERATE_ON } from "@/ai/draft-checks";
import type { ModelDraft } from "@/ai/prompts/draft.v6";
import { DRAFT_INSTRUCTIONS } from "@/ai/prompts/draft.v9";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailReasons } from "@/server/autopilot";
import { batchEligible } from "@/server/batch-rules";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const INSURANCE_FLAG =
  "Talks about the deductible or the insurance claim in a way you may not be allowed to promise. Check it.";
const customer =
  "The storm took half our shingles. Our deductible is $1,000. Can you meet the adjuster Thursday at 10?";
const ctx = { sourceText: customer, ownerSourceText: "", doNotPromise: [], phrasesAvoided: [] };

describe("insurance-job promises (Check 40 P1)", () => {
  it.each([
    "No problem, we'll take care of the deductible for you so you don't pay anything out of pocket.",
    "We can waive the deductible on insurance jobs.",
    "Insurance will cover the whole roof, don't worry.",
    "Absolutely, we'll negotiate with your adjuster and get the whole roof approved.",
    "We handle the whole insurance claim for you, start to finish.",
    "Just sign the authorization today and we'll take it from there.",
    "Sign our assignment of benefits form and the insurance pays us directly.",
    "We'll take care of your $1,000 deductible.",
  ])("flags: %s", (body) => {
    const r = checkDraft(body, ctx);
    expect(r.hits).toContain("insurance");
    expect(r.flags).toContain(INSURANCE_FLAG);
    expect(r.confidenceCap).toBeLessThanOrEqual(0.2);
  });

  it.each([
    "I'll meet your adjuster Thursday at 10 if that works.",
    "Send me the claim number when you have it.",
    "Your deductible is between you and your insurance company.",
    "We'll send our estimate and photos to the adjuster.",
  ])("leaves alone: %s", (body) => {
    expect(checkDraft(body, ctx).hits).not.toContain("insurance");
  });

  it("gets one fresh attempt, and the drafting prompt says the rule", () => {
    expect(REGENERATE_ON).toContain("insurance");
    expect(DRAFT_INSTRUCTIONS).toContain(
      "Never offer to pay, waive, cover or rebate an insurance deductible.",
    );
    expect(DRAFT_INSTRUCTIONS).toContain("Never ask anyone to sign today.");
  });

  it("an insurance flag keeps the draft out of autopilot and Send together", () => {
    const body = "We can waive the deductible on insurance jobs.";
    const r = checkDraft(body, ctx);
    expect(
      guardrailReasons({
        category: "customer_question",
        needsOwner: false,
        kind: "reply",
        confidencePct: 95,
        flags: r.flags,
        amountsInEmail: [],
        draftBody: body,
        knownCustomer: true,
        purpose: null,
      }),
    ).toContain("Has things to check before sending.");
    expect(
      batchEligible(
        {
          category: "customer_question",
          needsOwner: false,
          flags: r.flags,
          confidencePct: 95,
          body,
          amountsInEmail: [],
          untrusted: false,
          autopilotCounting: false,
          acceptsQuote: false,
          purpose: null,
          visitTime: false,
        },
        ["customer_question"],
      ),
    ).toBe(false);
  });

  it("the second, clean attempt is the one saved", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe", trade: "roofing" })
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
        subject: "Roof",
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
      subject: "Roof",
      bodyText: "Can you help with the deductible on the roof claim?",
      sentAt: new Date(now.getTime() - 3600_000),
    });
    const d = (body: string): ModelDraft => ({
      body,
      reason: "Roof claim question.",
      flags: [],
      confidence: 0.9,
      used_facts: [],
    });
    const second =
      "Hi Dana, the deductible is between you and your insurance company. Happy to meet the adjuster and share our estimate and photos.";
    const { transport, calls } = fakeTransport([
      d("Hi Dana, no problem, we'll take care of the deductible for you."),
      d(second),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t!.id, {
      trigger: "auto",
      writerFor: () => new FakeWriter(),
      now: () => now,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("Talks about the deductible");
    const [saved] = await database.select().from(drafts);
    expect(saved!.body).toBe(second);
    expect(saved!.flags).toEqual([]);
  });
});
