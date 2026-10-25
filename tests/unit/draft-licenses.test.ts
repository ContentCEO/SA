import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v6";
import type { Database } from "@/db";
import { businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T16:00:00Z");
const draft = (body: string): ModelDraft => ({
  body,
  reason: "Customer question. Gave the registration number.",
  flags: [],
  confidence: 0.95,
  used_facts: [],
});

/** Check 38 P6, case E10: "are you registered? what's your number?" */
describe("license numbers in a real draft (Check 38 P6)", () => {
  let database: Database;
  let workspaceId: string;
  let threadId: string;
  let writer: FakeWriter;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe", trade: "remodeling" })
      .where(eq(workspaces.id, workspaceId));
    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId: box.id,
        gmailThreadId: "t1",
        inInbox: true,
        subject: "Kitchen",
        category: "customer_question",
        classifiedAt: NOW,
        lastMessageAt: NOW,
      })
      .returning();
    threadId = t!.id;
    await database.insert(messages).values({
      threadId,
      mailboxId: box.id,
      gmailMessageId: "m1",
      rfc822MessageId: "<m1@x.com>",
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana",
      subject: "Kitchen",
      bodyText: "Before we sign: are you registered? What's your number?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    writer = new FakeWriter();
  });

  let system = "";
  const run = async () => {
    const answer = "Hi Dana, yes, we're registered. Our HIC number is 198344.";
    const { transport, calls } = fakeTransport([draft(answer), draft(answer)]);
    setModelTransportForTests(transport);
    await createDraftForThread(threadId, {
      trigger: "auto",
      writerFor: () => writer,
      now: () => NOW,
    });
    system = calls[0]!.system.map((b) => b.text).join("\n");
    const [d] = await database.select().from(drafts);
    return d!;
  };

  it("with the HIC saved: no flag, and the drafter was given it to quote", async () => {
    await database
      .insert(businessProfiles)
      .values({ workspaceId, licenses: { hic_number: "198344" } });
    const d = await run();
    expect(d.flags).toEqual([]);
    expect(d.promptVersion).toBe("draft.v9");
    expect(system).toContain(
      "- Registration and licenses (quote exactly; never add others): Home improvement registration (HIC) number: 198344",
    );
  });

  it("without it: the license flag, not a price flag", async () => {
    const d = await run();
    expect(d.flags).toContain(
      "Mentions a license or registration number you haven't saved. Check it.",
    );
    expect(d.flags).toContain("Says you're registered. Add it in Settings or take it out.");
    expect(d.flags.join(" ")).not.toContain("$198,344");
    expect(d.confidence).toBeLessThanOrEqual(30);
  });
});
