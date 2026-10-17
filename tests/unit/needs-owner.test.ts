import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { markNeedsOwner } from "@/server/classification";
import { listCustomers } from "@/server/customers";
import { markAnsweredByPhone } from "@/server/first-week";
import { threadsToFollowUp } from "@/server/followups";
import { listInboxThreads } from "@/server/inbox";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { clearAnsweredNeedsOwner, takeOffMyList } from "@/server/needs-owner";
import { isQuoteThread } from "@/server/quote-rules";
import {
  listDismissedQuotes,
  listQuotes,
  markQuoteSentAnotherWay,
  setQuoteDismissed,
  setQuoteOutcome,
} from "@/server/quotes";
import { incrementalSync, runBackfill } from "@/server/sync";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";
import { FakeWriter } from "../support/fake-writer";

/** Check 10 P1 + Check 11 P8: "Needs you" lets go once answered; quotes closed another way. */

const NOW = new Date("2026-09-28T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
let database: Database;
let workspaceId: string;
let mailboxId: string;
let fake: FakeMailbox;
const deps = () => ({ readerFor: () => fake.reader(), now: () => NOW });

const customer = (id: string, thread: string, daysAgo: number) =>
  fake.add({
    id,
    threadId: thread,
    daysAgo,
    labelIds: ["INBOX"],
    headers: {
      from: `Dana <dana-${thread}@customer.com>`,
      to: "owner@shop.com",
      subject: `Job ${thread}`,
      messageId: `<${id}@customer.com>`,
    },
  });
const owner = (id: string, thread: string, daysAgo: number, to?: string, subject?: string) =>
  fake.add({
    id,
    threadId: thread,
    daysAgo,
    labelIds: ["SENT"],
    headers: {
      from: "owner@shop.com",
      to: to ?? `dana-${thread}@customer.com`,
      subject: subject ?? `Re: Job ${thread}`,
      messageId: `<${id}@shop.com>`,
    },
  });

async function threadId(gmail: string) {
  const [t] = await database.select().from(threads).where(eq(threads.gmailThreadId, gmail));
  return t!;
}

/** As classification leaves it: flagged from the customer's email at `since`. */
async function flag(gmail: string, since: Date, category = "customer_question") {
  const t = await threadId(gmail);
  await database
    .update(threads)
    .set({
      category,
      needsOwner: true,
      needsOwnerReason: "A big job.",
      needsOwnerSince: since,
      classifiedAt: since,
    })
    .where(eq(threads.id, t.id));
  return t.id;
}

const row = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!;
const cleared = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "needs_owner_cleared"));

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: ["x"],
    })
  ).id;
  fake = new FakeMailbox();
});

describe("Needs you lets go once the owner answers (Check 10 P1)", () => {
  it("an owner reply from Gmail after the flag clears it on the next sync, logged content-free", async () => {
    customer("c1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const id = await flag("t1", ago(2));
    owner("o1", "t1", 1);
    await incrementalSync(mailboxId, deps());
    const t = await row(id);
    expect(t).toMatchObject({ needsOwner: false, needsOwnerManual: false, needsOwnerReason: null });
    const logs = await cleared();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({ by: "gmail_reply" });
    expect(logs[0]!.threadId).toBe(id);
  });

  it("an owner reply from before the flag does not clear it", async () => {
    customer("c1", "t1", 3);
    owner("o1", "t1", 2);
    customer("c2", "t1", 1);
    await runBackfill(mailboxId, deps());
    const id = await flag("t1", ago(1));
    expect(await clearAnsweredNeedsOwner(mailboxId)).toBe(0);
    expect((await row(id)).needsOwner).toBe(true);
    expect(await cleared()).toHaveLength(0);
  });

  it("a forward to the crew does not clear it", async () => {
    customer("c1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const id = await flag("t1", ago(2));
    owner("f1", "t1", 1, "mike@shop.com", "Fwd: Job t1");
    await incrementalSync(mailboxId, deps());
    expect((await row(id)).needsOwner).toBe(true);
  });

  it("an unsent Gmail draft does not clear it", async () => {
    customer("c1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const id = await flag("t1", ago(2));
    await database.insert(messages).values({
      threadId: id,
      mailboxId,
      gmailMessageId: "draft1",
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [`dana-t1@customer.com`],
      labelIds: ["DRAFT"],
      sentAt: ago(1),
    });
    expect(await clearAnsweredNeedsOwner(mailboxId)).toBe(0);
    expect((await row(id)).needsOwner).toBe(true);
  });

  it('"I called them" clears it (and logs by: phone)', async () => {
    customer("c1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const id = await flag("t1", ago(2));
    const writer = new FakeWriter();
    await markAnsweredByPhone(workspaceId, id, { writerFor: () => writer, now: () => NOW });
    expect((await row(id)).needsOwner).toBe(false);
    expect((await cleared())[0]!.detail).toEqual({ by: "phone" });
  });

  it("the owner's own mark set after their last reply survives the next sync", async () => {
    customer("c1", "t1", 3);
    owner("o1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const t = await threadId("t1");
    expect(await markNeedsOwner(workspaceId, t.id)).toBe(true);
    customer("c2", "t2", 1); // something new arrives, so the sync really runs
    await incrementalSync(mailboxId, deps());
    expect((await row(t.id)).needsOwner).toBe(true);
    expect((await row(t.id)).needsOwnerManual).toBe(true);
  });

  it("an old manual mark with no time never lets go on its own; an old sorter flag uses the sort time", async () => {
    customer("c1", "t1", 3);
    owner("o1", "t1", 1);
    customer("c2", "t2", 3);
    owner("o2", "t2", 1);
    await runBackfill(mailboxId, deps());
    const a = (await threadId("t1")).id;
    const b = (await threadId("t2")).id;
    await database
      .update(threads)
      .set({ needsOwner: true, needsOwnerManual: true, classifiedAt: ago(3) })
      .where(eq(threads.id, a));
    await database
      .update(threads)
      .set({ needsOwner: true, classifiedAt: ago(3) })
      .where(eq(threads.id, b));
    expect(await clearAnsweredNeedsOwner(mailboxId)).toBe(1);
    expect((await row(a)).needsOwner).toBe(true);
    expect((await row(b)).needsOwner).toBe(false);
  });

  it("the Inbox drops an answered thread back into date order, before any sync clears it", async () => {
    customer("c1", "t1", 3);
    customer("c2", "t2", 2);
    await runBackfill(mailboxId, deps());
    const older = await flag("t1", ago(3));
    const newer = (await threadId("t2")).id;
    let list = await listInboxThreads(workspaceId, { kind: "all" });
    expect(list.map((r) => r.id)).toEqual([older, newer]);
    expect(list[0]!.needsOwner).toBe(true);
    await database
      .update(threads)
      .set({ handledOfflineAt: ago(1) })
      .where(eq(threads.id, older));
    list = await listInboxThreads(workspaceId, { kind: "all" });
    expect(list.map((r) => r.id)).toEqual([newer, older]);
    expect(list.find((r) => r.id === older)!.needsOwner).toBe(false);
    expect(await listInboxThreads(workspaceId, { kind: "needs_me" })).toEqual([]);
  });

  it("Take it off my list: clears the flag; refuses another workspace and a read-only account", async () => {
    customer("c1", "t1", 3);
    owner("o1", "t1", 2);
    await runBackfill(mailboxId, deps());
    const t = await threadId("t1");
    await markNeedsOwner(workspaceId, t.id);
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    expect(await takeOffMyList(other.workspace.id, t.id, NOW)).toBe("not_found");
    expect((await row(t.id)).needsOwner).toBe(true);
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await expect(takeOffMyList(workspaceId, t.id, NOW)).rejects.toBeInstanceOf(ReadOnlyError);
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: new Date(NOW.getTime() + DAY) })
      .where(eq(workspaces.id, workspaceId));
    expect(await takeOffMyList(workspaceId, t.id, NOW)).toBe("cleared");
    expect(await row(t.id)).toMatchObject({ needsOwner: false, needsOwnerManual: false });
    expect((await cleared())[0]!.detail).toEqual({ by: "owner" });
    expect(await takeOffMyList(workspaceId, t.id, NOW)).toBe("not_flagged");
  });

  it("follow-ups: a quote cleared by a Gmail reply becomes eligible, unless it was answered by phone", async () => {
    customer("c1", "t1", 8);
    customer("c2", "t2", 8);
    await runBackfill(mailboxId, deps());
    const gmailQuote = await flag("t1", ago(8), "quote_request");
    const phoneQuote = await flag("t2", ago(8), "quote_request");
    owner("o1", "t1", 5);
    await incrementalSync(mailboxId, deps());
    expect((await row(gmailQuote)).needsOwner).toBe(false);
    await markAnsweredByPhone(workspaceId, phoneQuote, {
      writerFor: () => new FakeWriter(),
      now: () => ago(5),
    });
    expect((await row(phoneQuote)).needsOwner).toBe(false);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([gmailQuote]);
  });
});

describe("Quotes closed another way, and Not a quote (Check 11 P8)", () => {
  async function quote(gmail: string, daysAgo = 2) {
    customer(`c-${gmail}`, gmail, daysAgo);
    await runBackfill(mailboxId, deps());
    const t = await threadId(gmail);
    await database
      .update(threads)
      .set({ category: "quote_request", classifiedAt: ago(daysAgo) })
      .where(eq(threads.id, t.id));
    return t.id;
  }
  const stageOf = async (id: string) =>
    (await listQuotes(workspaceId, NOW)).quotes.find((q) => q.threadId === id);

  it("I sent the price another way: Quoted with the amount typed, or without one", async () => {
    const a = await quote("qa");
    const b = await quote("qb");
    expect((await stageOf(a))!.stage).toBe("waiting_on_you");
    const opts = { writerFor: () => new FakeWriter(), now: () => NOW };
    expect(await markQuoteSentAnotherWay(workspaceId, a, 145_000, opts)).toBe("marked");
    expect(await markQuoteSentAnotherWay(workspaceId, b, null, opts)).toBe("marked");
    // (Check 11 P6 "Replied" isn't built here: both read Quoted.)
    expect(await stageOf(a)).toMatchObject({ stage: "talking", amountCents: 145_000 });
    expect(await stageOf(b)).toMatchObject({ stage: "talking", amountCents: null });
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "answered_by_phone"));
    const byThread = new Map(logs.map((l) => [l.threadId, l.detail]));
    expect(byThread.get(a)).toEqual({ draftRemoved: false, via: "other", amountTyped: true });
    expect(byThread.get(b)).toEqual({ draftRemoved: false, via: "other" });
  });

  it("Not a quote leaves Quotes and Customers' open quotes; Put back restores it", async () => {
    const id = await quote("qn");
    expect((await listCustomers(workspaceId, NOW))[0]!.openQuotes).toBe(1);
    expect(await setQuoteDismissed(workspaceId, id, true, NOW)).toBe(true);
    expect(await stageOf(id)).toBeUndefined();
    expect((await listCustomers(workspaceId, NOW))[0]!.openQuotes).toBe(0);
    expect((await listDismissedQuotes(workspaceId)).map((d) => d.threadId)).toEqual([id]);
    expect(await setQuoteDismissed(workspaceId, id, false, NOW)).toBe(true);
    expect((await stageOf(id))!.stage).toBe("waiting_on_you");
    expect(await listDismissedQuotes(workspaceId)).toEqual([]);
  });

  it("an owner's outcome after Not a quote brings it back; our own guess doesn't", async () => {
    const id = await quote("qo");
    await setQuoteDismissed(workspaceId, id, true, ago(1));
    await database
      .update(threads)
      .set({ quoteOutcome: "no_answer", quoteOutcomeSource: "auto", quoteOutcomeAt: NOW })
      .where(eq(threads.id, id));
    expect(await stageOf(id)).toBeUndefined();
    await setQuoteOutcome(workspaceId, id, "won", null, NOW);
    expect((await stageOf(id))!.stage).toBe("won");
    const t = await row(id);
    expect(isQuoteThread(t)).toBe(true);
    expect(isQuoteThread({ ...t, quoteOutcomeAt: ago(2) })).toBe(false);
  });

  it("both are refused for another workspace and for a read-only account", async () => {
    const id = await quote("qr");
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    expect(await setQuoteDismissed(other.workspace.id, id, true, NOW)).toBe(false);
    expect(await markQuoteSentAnotherWay(other.workspace.id, id, null)).toBe("not_found");
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await expect(setQuoteDismissed(workspaceId, id, true, NOW)).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    await expect(markQuoteSentAnotherWay(workspaceId, id, 1000)).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    const t = await row(id);
    expect(t.quoteDismissedAt).toBeNull();
    expect(t.handledOfflineAt).toBeNull();
    expect(t.quoteAmountCents).toBeNull();
  });
});
