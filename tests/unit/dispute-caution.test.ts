import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { DISPUTE_REASON, LEGAL_REASON } from "@/ai/classify";
import {
  DISPUTE_CAUTION_PROMPT_VERSION,
  DISPUTE_FLAG,
  DISPUTE_TASK,
} from "@/ai/prompts/dispute-caution.v1";
import { confidenceLabel } from "@/config/drafting";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { considerAutopilot } from "@/server/autopilot";
import { createDraftForThread, reviseDraft } from "@/server/drafts";
import { fakeTransport } from "../support/fake-model";
import { NOW, sendPathWorld } from "../support/send-path";

/** Check 43 P9: a fixed caution on drafts that answer a lawyer or a dispute. */
const modelDraft = (
  body = "Hi Dana,\n\nThanks for letting me know. I'll call you today.\n\nSam",
) => ({
  body,
  reason: "Complaint. Acknowledged it.",
  flags: [],
  confidence: 0.97,
  used_facts: [],
  opening: "not_first",
});

describe("Check 43 P9: dispute and legal threads", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  let n = 0;
  beforeEach(async () => {
    process.env.AI_DAILY_CALL_CAP = "100";
    w = await sendPathWorld();
  });

  async function thread(over: {
    extracted?: Record<string, unknown>;
    needsOwner?: boolean;
    needsOwnerReason?: string | null;
    category?: string;
  }) {
    const g = `dc${++n}`;
    const [t] = await w.database
      .insert(threads)
      .values({
        mailboxId: w.mailbox.id,
        gmailThreadId: g,
        inInbox: true,
        subject: "The leak",
        category: (over.category ?? "complaint") as "complaint",
        needsOwner: over.needsOwner ?? true,
        needsOwnerReason: over.needsOwnerReason ?? null,
        extracted: over.extracted ?? {},
        classifiedAt: NOW,
        lastMessageAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    // The owner has written to Dana before (so it isn't a first contact).
    await w.database.insert(messages).values([
      {
        threadId: t!.id,
        mailboxId: w.mailbox.id,
        gmailMessageId: `${g}-earlier`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@x.com"],
        bodyText: "The roof is done, thanks.",
        sentAt: new Date(NOW.getTime() - 20 * 86_400_000),
      },
      {
        threadId: t!.id,
        mailboxId: w.mailbox.id,
        gmailMessageId: `${g}-in`,
        rfc822MessageId: `<${g}@x.com>`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana",
        toAddresses: ["owner@shop.com"],
        subject: "The leak",
        bodyText: "The ceiling leaks since your roof job. I want a refund or my lawyer will call.",
        sentAt: new Date(NOW.getTime() - 3600_000),
      },
    ]);
    return t!.id;
  }

  async function draftOn(threadId: string) {
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(threadId, {
      trigger: "owner",
      workspaceId: w.workspace.id,
      ...w.deps(),
    });
    if (r.status !== "created") throw new Error(JSON.stringify(r));
    const [d] = await w.database.select().from(drafts).where(eq(drafts.id, r.draftId));
    return { draft: d!, calls };
  }

  for (const [name, mark] of [
    ["the dispute mark", { extracted: { disputed: true }, needsOwnerReason: "Upset customer." }],
    ["the legal reason", { needsOwnerReason: LEGAL_REASON }],
    ["the money-back reason", { needsOwnerReason: DISPUTE_REASON }],
  ] as const) {
    it(`${name}: the fixed caution is first, confidence ≤ 40, never Ready, and the task says so`, async () => {
      const { draft, calls } = await draftOn(await thread(mark));
      expect(draft.flags[0]).toBe(DISPUTE_FLAG);
      expect(draft.confidence).toBeLessThanOrEqual(40);
      const label = confidenceLabel({
        confidencePct: draft.confidence,
        flags: draft.flags.length,
        gaps: 0,
      });
      expect(["check_everything", "check_details"]).toContain(label);
      expect(draft.promptVersion).toContain(`+${DISPUTE_CAUTION_PROMPT_VERSION}`);
      expect(JSON.stringify(calls[0])).toContain(DISPUTE_TASK);
    });
  }

  it("the same thread without the mark: no caution", async () => {
    const { draft, calls } = await draftOn(
      await thread({ needsOwnerReason: "Upset customer.", category: "complaint" }),
    );
    expect(draft.flags).not.toContain(DISPUTE_FLAG);
    // Only the usual checks cap it ("today" isn't in the email), not the dispute cap.
    expect(draft.confidence).toBeGreaterThan(40);
    expect(draft.promptVersion).not.toContain(DISPUTE_CAUTION_PROMPT_VERSION);
    expect(JSON.stringify(calls[0])).not.toContain(DISPUTE_TASK);
  });

  it("a quick change keeps the caution and the cap", async () => {
    const { draft } = await draftOn(await thread({ extracted: { disputed: true } }));
    const { transport } = fakeTransport([modelDraft("Hi Dana, I'll call you at 3.\nSam")]);
    setModelTransportForTests(transport);
    const r = await reviseDraft(w.workspace.id, draft.id, { tweak: "warmer" }, w.deps());
    expect(r.status).toBe("revised");
    const [after] = await w.database.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(after!.flags[0]).toBe(DISPUTE_FLAG);
    expect(after!.confidence).toBeLessThanOrEqual(40);
  });

  it("autopilot never counts one down, for either mark", async () => {
    await w.database
      .update(workspaces)
      .set({ plan: "crew" })
      .where(eq(workspaces.id, w.workspace.id));
    for (const mark of [
      // A disputed thread the owner took off "needs you", sorted as scheduling.
      { extracted: { disputed: true }, needsOwner: false, category: "scheduling" },
      { needsOwnerReason: LEGAL_REASON, needsOwner: true, category: "scheduling" },
    ]) {
      const { draft } = await draftOn(await thread(mark));
      expect(await considerAutopilot(draft.id, NOW)).toBeNull();
      const [after] = await w.database.select().from(drafts).where(eq(drafts.id, draft.id));
      expect(after!.autoSendAt).toBeNull();
    }
  });
});
