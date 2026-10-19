/**
 * Check 21 P2: "We went with someone else" stops nudges; "after the holidays" waits. The signals
 * are classify.v6's (`declines_quote`, `wait_until`), so the real classification path runs.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { activityLog, businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { classifyPending } from "@/server/classification";
import { createDraftForThread, sentDraftSummary } from "@/server/drafts";
import { followupSignalsOf, nudgeAfterFor, waitingLine } from "@/server/followup-rules";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { DECLINED_FLAG } from "@/server/quote-rules";
import { guessNoAnswers, listQuotes, setQuoteOutcome } from "@/server/quotes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;

/** A quote thread: the customer asked, the owner priced it. */
async function quote(askedAt: Date, quotedAt: Date) {
  const id = `q${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Deck",
      category: "quote_request",
      quoteRequestedAt: askedAt,
      classifiedAt: askedAt,
      lastMessageAt: quotedAt,
    })
    .returning();
  await database.insert(messages).values([
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      rfc822MessageId: `<${id}-in@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Deck",
      bodyText: "Can you price a deck?",
      labelIds: ["INBOX"],
      sentAt: askedAt,
      classifiedAt: askedAt,
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Deck",
      bodyText: "It's $6,400 for the deck.",
      sentAt: quotedAt,
    },
  ]);
  return { id: t!.id, gid: id };
}

let m = 0;
async function customerWrites(threadId: string, at: Date, body: string) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `c${++m}`,
    rfc822MessageId: `<c${m}@customer.com>`,
    direction: "in",
    fromAddress: "dana@customer.com",
    fromName: "Dana Ruiz",
    subject: "Re: Deck",
    bodyText: body,
    labelIds: ["INBOX"],
    sentAt: at,
  });
}
async function ownerWrites(threadId: string, at: Date, body: string) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `o${++m}`,
    rfc822MessageId: `<o${m}@shop.com>`,
    direction: "out",
    fromAddress: "owner@shop.com",
    toAddresses: ["dana@customer.com"],
    subject: "Re: Deck",
    bodyText: body,
    sentAt: at,
  });
}
const sorted = (over: { declines?: boolean; waitUntil?: string | null; category?: string }) =>
  ({
    ...classification({ category: (over.category ?? "quote_request") as "quote_request" }),
    signals: { ...classification().signals, declines_quote: over.declines ?? false },
    extracted: { ...classification().extracted, wait_until: over.waitUntil ?? null },
  }) as unknown;

/** 9:11am Eastern on each day from `from` for `days` days; returns the days a thread was due. */
async function scanDays(threadId: string, from: string, days: number) {
  const due: string[] = [];
  for (let i = 0; i < days; i++) {
    const at = new Date(Date.parse(`${from}T14:11:00Z`) + i * DAY);
    if ((await threadsToFollowUp(mailboxId, at)).includes(threadId))
      due.push(at.toISOString().slice(0, 10));
  }
  return due;
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
  await database
    .insert(businessProfiles)
    .values({ workspaceId, timeZone: "America/New_York" })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { timeZone: "America/New_York" },
    });
  writer = new FakeWriter();
  // The timelines are in Nov–Jan: an account past its trial, so jobs run.
  await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, workspaceId));
});

describe("follow-up signals (pure)", () => {
  const now = new Date("2026-12-17T15:00:00Z");
  it("reads declines_quote and a real, future wait_until; ignores the rest", () => {
    expect(
      followupSignalsOf(
        { signals: { declines_quote: true }, extracted: { wait_until: "2027-01-04" } },
        now,
      ),
    ).toEqual({ declines_quote: true, wait_until: "2027-01-04" });
    for (const bad of ["2026-12-01", "2028-06-01", "2027-02-30", "Jan 4", null, 5]) {
      expect(followupSignalsOf({ signals: {}, extracted: { wait_until: bad } }, now)).toEqual({});
    }
    // A classify version without them: nothing.
    expect(followupSignalsOf({ signals: {}, extracted: {} }, now)).toEqual({});
  });
  it("nudge_after is the start of that day in the owner's zone; the line shows only ahead", () => {
    const at = nudgeAfterFor("2027-01-04", "America/New_York")!;
    expect(at.toISOString()).toBe("2027-01-04T05:00:00.000Z");
    expect(nudgeAfterFor("2027-01-04", "America/Los_Angeles")!.toISOString()).toBe(
      "2027-01-04T08:00:00.000Z",
    );
    expect(waitingLine(at, now, "America/New_York")).toBe("Waiting until Jan 4, as they asked.");
    expect(waitingLine(at, new Date("2027-01-05T00:00:00Z"), "America/New_York")).toBeNull();
    expect(waitingLine(null, now, "America/New_York")).toBeNull();
  });
});

describe("we went with someone else (Check 21 P2)", () => {
  it("decline + owner thanks → our lost guess, no nudge in 30 days, Activity says so", async () => {
    const { id } = await quote(new Date("2026-11-02T14:00:00Z"), new Date("2026-11-03T14:00:00Z"));
    await customerWrites(
      id,
      new Date("2026-11-05T15:00:00Z"),
      "We went with someone else, thanks.",
    );
    setModelTransportForTests(fakeTransport([sorted({ declines: true })]).transport);
    await classifyPending(mailboxId, { now: new Date("2026-11-05T15:05:00Z") });
    await ownerWrites(id, new Date("2026-11-05T16:00:00Z"), "Thanks for letting me know.");

    const [t] = await database.select().from(threads).where(eq(threads.id, id));
    expect(t).toMatchObject({ quoteOutcome: "lost", quoteOutcomeSource: "auto" });
    expect(await scanDays(id, "2026-11-06", 30)).toEqual([]);
    setModelTransportForTests(fakeTransport([]).transport);
    expect(
      await createDraftForThread(id, {
        trigger: "followup",
        writerFor: () => writer,
        now: () => new Date("2026-11-12T14:11:00Z"),
      }),
    ).toEqual({ status: "skipped", reason: "followup_not_allowed" });

    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "quote_outcome_guessed"));
    expect(log!.detail).toEqual({ outcome: "lost", why: "declined" });
    expect(describeActivity(log!.action, log!.detail, { name: "Dana", category: null })).toMatch(
      /as lost — they said no\. Change it on Quotes/,
    );
  });

  it("a waiting nudge is flagged: they said no", async () => {
    const { id } = await quote(new Date("2026-11-02T14:00:00Z"), new Date("2026-11-03T14:00:00Z"));
    await database.insert(drafts).values({
      threadId: id,
      mailboxId,
      kind: "followup",
      gmailDraftId: "gd-1",
      toAddress: "dana@customer.com",
      subject: "Re: Deck",
      body: "Just checking in.",
      originalBody: "Just checking in.",
      status: "pending",
      reason: "nudge",
      promptVersion: "followup.v4",
    });
    await customerWrites(id, new Date("2026-11-07T15:00:00Z"), "No thanks, we'll hold off.");
    setModelTransportForTests(fakeTransport([sorted({ declines: true })]).transport);
    await classifyPending(mailboxId, { now: new Date("2026-11-07T15:05:00Z") });
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, id));
    expect(d!.flags).toContain(DECLINED_FLAG);
  });

  it("never overwrites the owner's own Won or Lost", async () => {
    for (const outcome of ["won", "lost"] as const) {
      const { id } = await quote(
        new Date("2026-11-02T14:00:00Z"),
        new Date("2026-11-03T14:00:00Z"),
      );
      await setQuoteOutcome(workspaceId, id, outcome, null, new Date("2026-11-04T14:00:00Z"));
      await customerWrites(id, new Date("2026-11-05T15:00:00Z"), "We went with someone else.");
      setModelTransportForTests(fakeTransport([sorted({ declines: true })]).transport);
      await classifyPending(mailboxId, { now: new Date("2026-11-05T15:05:00Z") });
      const [t] = await database.select().from(threads).where(eq(threads.id, id));
      expect(t).toMatchObject({ quoteOutcome: outcome, quoteOutcomeSource: "owner" });
    }
  });
});

describe("after the holidays (Check 21 P2)", () => {
  async function holidays() {
    const { id } = await quote(new Date("2026-12-10T14:00:00Z"), new Date("2026-12-14T14:00:00Z"));
    await customerWrites(
      id,
      new Date("2026-12-17T15:00:00Z"),
      "We'll get back to you after the holidays.",
    );
    setModelTransportForTests(fakeTransport([sorted({ waitUntil: "2027-01-04" })]).transport);
    await classifyPending(mailboxId, { now: new Date("2026-12-17T15:05:00Z") });
    await ownerWrites(id, new Date("2026-12-17T16:00:00Z"), "Sounds good, talk in January.");
    return id;
  }

  it("no December nudge; the first is due on Jan 4; the card and sent screen say so", async () => {
    const id = await holidays();
    const [t] = await database.select().from(threads).where(eq(threads.id, id));
    expect(t!.nudgeAfter!.toISOString()).toBe("2027-01-04T05:00:00.000Z");
    const due = await scanDays(id, "2026-12-18", 24);
    expect(due[0]).toBe("2027-01-04");
    expect(due.every((d) => d >= "2027-01-04")).toBe(true);
    setModelTransportForTests(fakeTransport([]).transport);
    expect(
      await createDraftForThread(id, {
        trigger: "followup",
        writerFor: () => writer,
        now: () => new Date("2026-12-28T14:11:00Z"),
      }),
    ).toEqual({ status: "skipped", reason: "wait_requested" });

    const { quotes } = await listQuotes(workspaceId, new Date("2026-12-20T15:00:00Z"));
    expect(quotes.find((q) => q.threadId === id)!.waitingLine).toBe(
      "Waiting until Jan 4, as they asked.",
    );
  });

  it("the no-answer guess counts quiet days from the date they asked for", async () => {
    const id = await holidays();
    // 21 days after the owner's Dec 17 email, but only 3 after Jan 4: no guess yet.
    await guessNoAnswers(new Date("2027-01-07T15:00:00Z"), workspaceId);
    let [t] = await database.select().from(threads).where(eq(threads.id, id));
    expect(t!.quoteOutcome).toBeNull();
    await guessNoAnswers(new Date("2027-01-26T15:00:00Z"), workspaceId);
    [t] = await database.select().from(threads).where(eq(threads.id, id));
    expect(t!.quoteOutcome).toBe("no_answer");
  });

  it("the customer writing again clears the wait", async () => {
    const id = await holidays();
    await customerWrites(id, new Date("2026-12-20T15:00:00Z"), "Actually, can you start sooner?");
    setModelTransportForTests(fakeTransport([sorted({ category: "scheduling" })]).transport);
    await classifyPending(mailboxId, { now: new Date("2026-12-20T15:05:00Z") });
    const [t] = await database.select().from(threads).where(eq(threads.id, id));
    expect(t!.nudgeAfter).toBeNull();
  });

  it("the sent screen says it's waiting, not the next nudge day", async () => {
    const id = await holidays();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: id,
        mailboxId,
        kind: "reply",
        gmailDraftId: "gd-2",
        toAddress: "dana@customer.com",
        subject: "Re: Deck",
        body: "Sounds good.",
        originalBody: "Sounds good.",
        status: "sent",
        reason: "reply",
        promptVersion: "draft.v8",
        decidedAt: new Date("2026-12-17T16:00:00Z"),
      })
      .returning();
    await database.update(threads).set({ category: "quote_request" }).where(eq(threads.id, id));
    const s = await sentDraftSummary(workspaceId, d!.id, new Date("2026-12-17T16:01:00Z"));
    expect(s!.waitingUntil!.toISOString()).toBe("2027-01-04T05:00:00.000Z");
  });
});
