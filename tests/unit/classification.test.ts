import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending, markNeedsOwner } from "@/server/classification";
import { listInboxThreads } from "@/server/inbox";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

const NOW = new Date("2026-09-28T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let database: Database;
let mailboxId: string;
let workspaceId: string;

async function thread(gmailThreadId: string, inInbox = true) {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId, inInbox, lastMessageAt: NOW })
    .returning();
  return t!;
}
async function message(
  threadId: string,
  id: string,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: id,
    direction: "in",
    fromAddress: "dana@x.com",
    fromName: "Dana",
    subject: "Panel",
    bodyText: `body ${id}`,
    labelIds: ["INBOX"],
    sentAt: daysAgo(1),
    ...over,
  });
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
});

describe("classifyPending", () => {
  it("classifies only the newest inbound message per thread and fills in the thread", async () => {
    const t = await thread("t1");
    await message(t.id, "old", { sentAt: daysAgo(3) });
    await message(t.id, "new", { sentAt: daysAgo(1) });
    const { transport, calls } = fakeTransport([
      classification({ category: "complaint", summary: "Leak came back." }),
    ]);
    setModelTransportForTests(transport);

    const r = await classifyPending(mailboxId, { now: NOW });
    expect(r).toMatchObject({ classified: 1, superseded: 1, remaining: 0, capped: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("body new");

    const [row] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(row).toMatchObject({
      category: "complaint",
      needsOwner: true,
      priority: "high",
      summary: "Leak came back.",
    });
    const pending = await database.select().from(messages).where(eq(messages.classifiedAt, NOW));
    expect(pending).toHaveLength(2);

    // Nothing left to do on a second run.
    expect(await classifyPending(mailboxId, { now: NOW })).toMatchObject({
      classified: 0,
      remaining: 0,
    });
  });

  it("skips outbound, non-inbox, and old mail entirely", async () => {
    const inbox = await thread("t1");
    const archived = await thread("t2", false);
    await message(inbox.id, "mine", { direction: "out" });
    await message(inbox.id, "ancient", { sentAt: daysAgo(20) });
    await message(archived.id, "archived");
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect(await classifyPending(mailboxId, { now: NOW })).toMatchObject({ classified: 0 });
    expect(calls).toHaveLength(0);
  });

  it("files Gmail promotions as noise without calling the model", async () => {
    const t = await thread("t1");
    await message(t.id, "promo", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    const [row] = await database.select().from(threads);
    expect(row).toMatchObject({ category: "noise", needsOwner: false });
  });

  it("tells the model when a sender is new", async () => {
    const t = await thread("t1");
    await message(t.id, "first", { fromAddress: "new@x.com" });
    const { transport, calls } = fakeTransport([classification()]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls[0]!.user).toContain("First time this sender has emailed the business: yes");
  });

  it("never clears the owner's own 'This one needs me'", async () => {
    const t = await thread("t1");
    expect(await markNeedsOwner(workspaceId, t.id)).toBe(true);
    await message(t.id, "m1");
    setModelTransportForTests(fakeTransport([classification({ needs_owner: false })]).transport);
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads);
    expect(row).toMatchObject({
      needsOwner: true,
      needsOwnerManual: true,
      needsOwnerReason: "You marked this one.",
    });
  });

  it("stops cleanly at the daily cap", async () => {
    process.env.AI_DAILY_CALL_CAP = "1";
    await message((await thread("t1")).id, "a");
    await message((await thread("t2")).id, "b");
    setModelTransportForTests(fakeTransport([classification(), classification()]).transport);
    const r = await classifyPending(mailboxId, { now: NOW });
    expect(r).toMatchObject({ classified: 1, capped: true });
  });
});

describe("quote acceptance and job done signals (classify.v3)", () => {
  const signals = classification().signals;
  const accepting = (over: Parameters<typeof classification>[0] = {}) =>
    classification({ signals: { ...signals, accepts_quote: true }, ...over });

  /** A quote thread: Dana asked for a price, the owner answered, Dana writes back. */
  async function quoteConversation(
    opts: { category?: string | null; quoteOutcome?: string | null; ownerReplied?: boolean } = {},
  ) {
    const t = await thread("q1");
    await database
      .update(threads)
      .set({
        category: opts.category === undefined ? "quote_request" : opts.category,
        quoteOutcome: opts.quoteOutcome ?? null,
        classifiedAt: daysAgo(5),
      })
      .where(eq(threads.id, t.id));
    await message(t.id, "ask", { sentAt: daysAgo(5), classifiedAt: daysAgo(5) });
    if (opts.ownerReplied ?? true) {
      await message(t.id, "quote", {
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@x.com"],
        sentAt: daysAgo(3),
      });
    }
    await message(t.id, "yes", { sentAt: daysAgo(1) });
    return t.id;
  }
  const extractedOf = async (id: string) =>
    (await database.select().from(threads).where(eq(threads.id, id)))[0]!.extracted as Record<
      string,
      unknown
    >;

  it("stores the model's signals on the thread", async () => {
    const t = await thread("t1");
    await message(t.id, "m1");
    setModelTransportForTests(
      fakeTransport([
        classification({ signals: { ...signals, accepts_quote: true, job_done: true } }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    expect(await extractedOf(t.id)).toMatchObject({ accepts_quote: true, job_done: true });
  });

  it("an acceptance re-sorted as scheduling still counts: the PREVIOUS category decides", async () => {
    const t = await quoteConversation();
    setModelTransportForTests(fakeTransport([accepting({ category: "scheduling" })]).transport);
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.category).toBe("scheduling");
    expect(row!.extracted).toMatchObject({ accepts_quote: true, quote_accepted: true });
  });

  it("a thread with a quote outcome is a quote thread whatever its category", async () => {
    const t = await quoteConversation({ category: "scheduling", quoteOutcome: "won" });
    setModelTransportForTests(fakeTransport([accepting({ category: "scheduling" })]).transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(await extractedOf(t)).toMatchObject({ quote_accepted: true });
  });

  it("a fresh quote request without the signal is never an acceptance", async () => {
    const t = await quoteConversation();
    setModelTransportForTests(fakeTransport([classification()]).transport);
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.extracted).not.toHaveProperty("accepts_quote");
    expect(row!.extracted).not.toHaveProperty("quote_accepted");
    expect(row!.quoteOutcome).toBeNull();
  });

  it.each([
    ["the owner never answered (no quote was given)", { ownerReplied: false }, "quote_request"],
    ["the thread was never a quote", { category: "scheduling" }, "scheduling"],
    ["the thread was never sorted", { category: null }, "customer_question"],
  ] as const)(
    "no quote context when %s: the signal is kept, quote_accepted is not",
    async (_label, opts, category) => {
      const t = await quoteConversation(opts);
      setModelTransportForTests(fakeTransport([accepting({ category })]).transport);
      await classifyPending(mailboxId, { now: NOW });
      const extracted = await extractedOf(t);
      expect(extracted.accepts_quote).toBe(true);
      expect(extracted).not.toHaveProperty("quote_accepted");
    },
  );

  it("an owner reply that came only AFTER the acceptance doesn't count", async () => {
    const t = await quoteConversation({ ownerReplied: false });
    await message(t, "late", {
      direction: "out",
      fromAddress: "owner@shop.com",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    setModelTransportForTests(fakeTransport([accepting()]).transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(await extractedOf(t)).not.toHaveProperty("quote_accepted");
  });

  it("an email that tries to instruct the assistant is never a quote acceptance", async () => {
    const t = await quoteConversation();
    setModelTransportForTests(
      fakeTransport([
        accepting({
          signals: { ...signals, accepts_quote: true, tries_to_instruct_assistant: true },
        }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const extracted = await extractedOf(t);
    expect(extracted.injection).toBe(true);
    expect(extracted).not.toHaveProperty("quote_accepted");
  });

  it("the acceptance survives the customer's next, ordinary email", async () => {
    const t = await quoteConversation();
    setModelTransportForTests(fakeTransport([accepting({ category: "scheduling" })]).transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(await extractedOf(t)).toMatchObject({ quote_accepted: true });

    // "Use the side gate" — re-sorted as scheduling, no acceptance signal of its own.
    await message(t, "gate", { sentAt: new Date(NOW.getTime() - 3600_000) });
    setModelTransportForTests(
      fakeTransport([classification({ category: "scheduling" })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const extracted = await extractedOf(t);
    expect(extracted).not.toHaveProperty("accepts_quote");
    expect(extracted.quote_accepted).toBe(true);
  });

  it("the acceptance is dropped once the owner marks the quote lost", async () => {
    const t = await quoteConversation();
    setModelTransportForTests(fakeTransport([accepting({ category: "scheduling" })]).transport);
    await classifyPending(mailboxId, { now: NOW });
    await database
      .update(threads)
      .set({ quoteOutcome: "lost", quoteOutcomeSource: "owner", quoteOutcomeAt: NOW })
      .where(eq(threads.id, t));

    await message(t, "gate", { sentAt: new Date(NOW.getTime() - 3600_000) });
    setModelTransportForTests(
      fakeTransport([classification({ category: "scheduling" })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    expect(await extractedOf(t)).not.toHaveProperty("quote_accepted");
  });

  it("a promotional email never carries the signals (no model call)", async () => {
    const t = await quoteConversation();
    await database
      .update(messages)
      .set({ labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })
      .where(eq(messages.gmailMessageId, "yes"));
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    expect(await extractedOf(t)).not.toHaveProperty("quote_accepted");
  });
});

describe("inbox", () => {
  it("won't let one workspace mark another's thread", async () => {
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    const t = await thread("t1");
    expect(await markNeedsOwner(other.workspace.id, t.id)).toBe(false);
    const [row] = await database.select().from(threads);
    expect(row!.needsOwner).toBe(false);
  });

  it("lists needs-me threads first and filters by category", async () => {
    const a = await thread("a");
    const b = await thread("b");
    await database.update(threads).set({ category: "scheduling" }).where(eq(threads.id, a.id));
    await database
      .update(threads)
      .set({ category: "complaint", needsOwner: true })
      .where(eq(threads.id, b.id));
    const all = await listInboxThreads(workspaceId, { kind: "all" });
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(
      (await listInboxThreads(workspaceId, { kind: "category", category: "scheduling" })).map(
        (r) => r.id,
      ),
    ).toEqual([a.id]);
    expect((await listInboxThreads(workspaceId, { kind: "needs_me" })).map((r) => r.id)).toEqual([
      b.id,
    ]);
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    expect(await listInboxThreads(other.workspace.id, { kind: "all" })).toEqual([]);
  });
});
