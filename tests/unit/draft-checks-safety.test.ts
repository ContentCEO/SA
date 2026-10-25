import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft, olderHome, REGENERATE_ON } from "@/ai/draft-checks";
import type { ModelDraft } from "@/ai/prompts/draft.v6";
import { DRAFT_INSTRUCTIONS } from "@/ai/prompts/draft.v9";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { batchCandidates, createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const OLD = "We're in a 1924 colonial with two kids, 3 and 5. Can you repaint the outside?";
const ctx = (sourceText: string) => ({
  sourceText,
  ownerSourceText: "",
  doNotPromise: [],
  phrasesAvoided: [],
});

describe("lead-paint and safety claims (Check 41 P1)", () => {
  it.each([
    "No need to worry about lead with an exterior job.",
    "We'll power sand the whole house smooth.",
    "We'll burn off the old paint with a torch.",
    "It's completely safe for the baby and non-toxic.",
    "Totally safe for pets and kids once it dries.",
    "The house is lead-free, so no special steps.",
    "It's a pet-safe treatment.",
  ])("flags on an older home: %s", (body) => {
    const r = checkDraft(body, ctx(OLD));
    expect(r.hits).toContain("safety");
    expect(r.flags.join(" ")).toContain(
      "Safety and lead claims are yours to make, not the assistant's. Check it before sending.",
    );
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
  });

  it("the customer asking doesn't make it the owner's claim; an honest answer passes", () => {
    const source = "Is it safe for the baby?";
    expect(checkDraft("It's totally safe for the baby.", ctx(source)).hits).toContain("safety");
    expect(checkDraft("Good question. Rosa will answer that.", ctx(source)).hits).toEqual([]);
  });

  it.each([
    "We'll keep it safe from the rain.",
    "The paint needs to dry overnight.",
    "Safe travels this weekend!",
  ])("ordinary sentences stay clean: %s", (body) => {
    expect(checkDraft(body, ctx(OLD)).hits).not.toContain("safety");
  });

  it("power sanding is only a problem on an older home", () => {
    expect(olderHome("Built in 1924, a colonial.")).toBe(true);
    expect(olderHome("It's a 1995 house.")).toBe(false);
    expect(olderHome("Old house, plaster walls.")).toBe(true);
    expect(olderHome("pre-1978 home")).toBe(true);
    const body = "We'll power sand the siding first.";
    expect(checkDraft(body, ctx("Our 1924 house needs paint.")).hits).toContain("safety");
    expect(checkDraft(body, ctx("Our 1995 house needs paint.")).hits).not.toContain("safety");
  });

  it("one fresh attempt first, and the prompt says the rule", () => {
    expect(REGENERATE_ON).toContain("safety");
    expect(DRAFT_INSTRUCTIONS).toContain(
      "Never say a product, paint, spray or bait is safe, non-toxic or harmless, and never say lead isn't a concern.",
    );
  });

  it("a draft that keeps the claim is flagged, capped and left out of Send together", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe", trade: "painting" })
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
        subject: "Exterior paint",
        category: "quote_request",
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
      subject: "Exterior paint",
      bodyText: OLD,
      sentAt: new Date(now.getTime() - 3600_000),
    });
    const lead = "Hi Dana, no need to worry about lead with an exterior job. What colour?";
    const d: ModelDraft = {
      body: lead,
      reason: "Quote.",
      flags: [],
      confidence: 0.9,
      used_facts: [],
    };
    const { transport, calls } = fakeTransport([d, d]);
    setModelTransportForTests(transport);
    await createDraftForThread(t!.id, {
      trigger: "auto",
      writerFor: () => new FakeWriter(),
      now: () => now,
    });
    expect(calls).toHaveLength(2);
    const [saved] = await database.select().from(drafts);
    expect(saved!.flags.join(" ")).toContain("no lead worries");
    expect(saved!.confidence).toBeLessThanOrEqual(30);
    expect(await batchCandidates(workspace.id, ["quote_request"])).toEqual([]);
  });
});
