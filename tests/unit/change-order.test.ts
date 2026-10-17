import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { considerAutopilot } from "@/server/autopilot";
import { classifyPending } from "@/server/classification";
import { CHANGE_ORDER_FLAG, createDraftForThread } from "@/server/drafts";
import { classification, fakeTransport } from "../support/fake-model";
import { NOW, sendPathWorld } from "../support/send-path";

/**
 * Check 38 P1: a homeowner's "go ahead with the lights and the outlet" on a job already won is
 * a change order — an ordinary reply with a fixed reminder, never a deposit note.
 */
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const reply = (body = "Hi Dana,\n\nGreat, we'll add the lights and the outlet.\n\nDavi") => ({
  body,
  reason: "Approved the extra work.",
  flags: [],
  confidence: 0.95,
  used_facts: [],
  opening: "not_first",
});

describe("Check 38 P1: a change-order approval gets no deposit note", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  let n = 0;
  beforeEach(async () => {
    process.env.AI_DAILY_CALL_CAP = "100";
    w = await sendPathWorld();
  });

  /** S3: a quote thread; the owner priced it; then the customer's yes (unclassified). */
  async function scenario(outcome: { won: boolean; source?: "owner" | "auto" }) {
    const g = `co${++n}`;
    const [t] = await w.database
      .insert(threads)
      .values({
        mailboxId: w.mailbox.id,
        gmailThreadId: g,
        inInbox: true,
        subject: "Kitchen lights",
        category: "quote_request",
        classifiedAt: daysAgo(3),
        lastMessageAt: daysAgo(1),
        ...(outcome.won
          ? {
              quoteOutcome: "won",
              quoteOutcomeSource: outcome.source ?? "owner",
              quoteOutcomeAt: daysAgo(10),
            }
          : {}),
      })
      .returning();
    const base = { threadId: t!.id, mailboxId: w.mailbox.id, subject: "Kitchen lights" };
    await w.database.insert(messages).values([
      {
        ...base,
        gmailMessageId: `${g}-ask`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana",
        toAddresses: ["owner@shop.com"],
        bodyText: "While you're here, can you add lights over the island and move the outlet?",
        sentAt: daysAgo(4),
        classifiedAt: daysAgo(4),
      },
      {
        ...base,
        gmailMessageId: `${g}-price`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@x.com"],
        labelIds: ["SENT"],
        bodyText:
          "Hi Dana, four recessed lights over the island and moving the outlet adds $1,850.",
        sentAt: daysAgo(3),
      },
      {
        ...base,
        gmailMessageId: `${g}-yes`,
        rfc822MessageId: `<${g}-yes@x.com>`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana",
        toAddresses: ["owner@shop.com"],
        bodyText: "Sounds good, go ahead with the lights and the outlet.",
        labelIds: ["INBOX"],
        sentAt: daysAgo(1),
      },
    ]);
    setModelTransportForTests(
      fakeTransport([
        classification({
          category: "quote_request",
          signals: { ...classification().signals, accepts_quote: true },
        }),
      ]).transport,
    );
    await classifyPending(w.mailbox.id, { now: NOW });
    return t!.id;
  }
  const extractedOf = async (id: string) =>
    (await w.database.select().from(threads).where(eq(threads.id, id)))[0]!.extracted as Record<
      string,
      unknown
    >;
  async function draft(threadId: string, trigger: "auto" | "owner" = "auto") {
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(threadId, {
      trigger,
      workspaceId: w.workspace.id,
      ...w.deps(),
    });
    if (r.status !== "created") throw new Error(JSON.stringify(r));
    const [d] = await w.database.select().from(drafts).where(eq(drafts.id, r.draftId));
    return { d: d!, calls };
  }

  for (const source of ["owner", "auto"] as const) {
    it(`S3 (won by ${source} before the yes): no deposit, the change-order flag, no quote_accepted`, async () => {
      const t = await scenario({ won: true, source });
      const x = await extractedOf(t);
      expect(x).toMatchObject({ accepts_quote: true, change_order_approved: true });
      expect(x).not.toHaveProperty("quote_accepted");
      const { d, calls } = await draft(t);
      expect(d.purpose).toBeNull();
      expect(d.flags).toContain(CHANGE_ORDER_FLAG);
      expect(JSON.stringify(calls[0])).not.toContain("## Task: deposit");
    });
  }

  it("a first acceptance on an open quote still gets the deposit note", async () => {
    const t = await scenario({ won: false });
    const x = await extractedOf(t);
    expect(x).toMatchObject({ quote_accepted: true });
    expect(x).not.toHaveProperty("change_order_approved");
    const { d } = await draft(t);
    expect(d.purpose).toBe("deposit");
    expect(d.flags).not.toContain(CHANGE_ORDER_FLAG);
  });

  it("an older acceptance kept on a won thread still gets no deposit for the change order", async () => {
    const t = await scenario({ won: true });
    // The thread carries an earlier acceptance (the first yes, with no deposit note drafted).
    await w.database
      .update(threads)
      .set({
        extracted: { ...(await extractedOf(t)), quote_accepted: true },
      })
      .where(eq(threads.id, t));
    const { d } = await draft(t, "owner");
    expect(d.purpose).toBeNull();
  });

  it("autopilot never counts down a change-order approval", async () => {
    await w.database
      .update(workspaces)
      .set({ plan: "crew" })
      .where(eq(workspaces.id, w.workspace.id));
    const t = await scenario({ won: true });
    const { d } = await draft(t);
    expect(await considerAutopilot(d.id, NOW)).toBeNull();
    const [after] = await w.database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after!.autoSendAt).toBeNull();
  });
});
