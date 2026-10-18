import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { drafts, messages, threads } from "@/db/schema";
import { toMailMessage } from "@/mailbox/gmail/parse";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailReasons } from "@/server/autopilot";
import { BOUNCED_LINE, bouncedLine, isAutoReply, isBounceSender } from "@/server/auto-reply-rules";
import { classifyPending } from "@/server/classification";
import { createDraftForThread, threadsToAutoDraft } from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { incrementalSync, runBackfill } from "@/server/sync";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/** Check 20 P4 + Check 21 P1: automatic replies, bounces and bare acknowledgements. */

const DAY = 86_400_000;
const NOW = new Date("2026-10-05T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const nudge = (): ModelDraft => ({
  body: "Hi Dana,\n\nJust checking you got the quote. Any questions, shout.\n\nThanks, Davi",
  reason: "Gentle nudge.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
});

let database: Database;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  writer = new FakeWriter();
});
afterEach(() => vi.restoreAllMocks());

describe("what counts as an automatic reply", () => {
  it("each header and subject that says so", () => {
    expect(isAutoReply({ autoSubmitted: "auto-replied" })).toBe(true);
    expect(isAutoReply({ autoSubmitted: "Auto-Replied; owner-email=x@y.com" })).toBe(true);
    expect(isAutoReply({ autoSubmitted: "no" })).toBe(false);
    expect(isAutoReply({ xAutoreply: "yes" })).toBe(true);
    expect(isAutoReply({ xAutorespond: "" })).toBe(true);
    expect(isAutoReply({ precedence: "auto_reply" })).toBe(true);
    expect(isAutoReply({ precedence: "first-class" })).toBe(false);
    for (const subject of [
      "Automatic reply: Re: Estimate",
      "Auto: Re: Estimate",
      "Out of Office: Re: Estimate",
      "Out of the office until Monday",
      "Autoreply: Re: Estimate",
    ])
      expect(isAutoReply({ subject }), subject).toBe(true);
    expect(isAutoReply({}, "mailer-daemon@googlemail.com")).toBe(true);
    expect(isAutoReply({}, "postmaster@shop.com")).toBe(true);
  });

  it("GUARDRAIL: machine-made leads are still read (a lead site, a website form, a voicemail email)", () => {
    // Not responses: they're new leads, so they must reach the sorter.
    expect(isAutoReply({ autoSubmitted: "auto-generated" }, "leads@thumbtack.com")).toBe(false);
    for (const p of ["bulk", "junk", "list", "Bulk"])
      expect(isAutoReply({ precedence: p }, "wordpress@site.com"), p).toBe(false);
  });

  it("an ordinary email that mentions being out of office is not one", () => {
    expect(isAutoReply({ subject: "Re: Estimate" }, "dana@customer.com")).toBe(false);
    expect(isAutoReply({ subject: "I'll be out of office Friday, can you come Monday?" })).toBe(
      false,
    );
    expect(isBounceSender("dana@customer.com")).toBe(false);
  });

  it("Gmail's headers are read into the message (values never leave the reader)", () => {
    const m = toMailMessage(
      {
        id: "m",
        threadId: "t",
        payload: {
          headers: [
            { name: "Auto-Submitted", value: "auto-replied" },
            { name: "X-Auto-Response-Suppress", value: "All" },
            { name: "Precedence", value: "bulk" },
          ],
        },
      },
      false,
    );
    expect(m.headers).toMatchObject({
      autoSubmitted: "auto-replied",
      autoResponseSuppress: "All",
      precedence: "bulk",
    });
  });
});

describe("sync stores the flag", () => {
  it("from each header, the subject, or a bounce; never on an ordinary email", async () => {
    const fake = new FakeMailbox();
    const h = (extra: Record<string, string>, from = "Dana <dana@customer.com>") => ({
      from,
      to: "owner@shop.com",
      subject: "Re: Estimate",
      ...extra,
    });
    fake.add({ id: "as", threadId: "t1", headers: h({ autoSubmitted: "auto-replied" }) });
    fake.add({ id: "xa", threadId: "t2", headers: h({ xAutoreply: "yes" }) });
    fake.add({ id: "pr", threadId: "t3", headers: h({ precedence: "auto_reply" }) });
    fake.add({ id: "sj", threadId: "t4", headers: h({ subject: "Automatic reply: Estimate" }) });
    fake.add({ id: "bo", threadId: "t5", headers: h({}, "Mail Delivery <mailer-daemon@x.com>") });
    fake.add({
      id: "ok",
      threadId: "t6",
      headers: h({}),
      bodyText: "I'm out of office Friday. Can you come Monday?",
    });
    await runBackfill(mailboxId, { readerFor: () => fake.reader(), now: () => NOW });
    const rows = await database.select().from(messages);
    const flag = Object.fromEntries(rows.map((r) => [r.gmailMessageId, r.autoReply]));
    expect(flag).toEqual({ as: true, xa: true, pr: true, sj: true, bo: true, ok: false });
  });
});

/** The owner quoted Dana `quotedDaysAgo` days ago, after her request. */
async function quoted(quotedDaysAgo = 10) {
  const id = `q${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Estimate",
      category: "quote_request",
      summary: "Dana wants a quote.",
      classifiedAt: daysAgo(quotedDaysAgo + 1),
      lastMessageAt: daysAgo(quotedDaysAgo),
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
      subject: "Estimate",
      bodyText: "Can you quote a new deck?",
      sentAt: daysAgo(quotedDaysAgo + 1),
      classifiedAt: daysAgo(quotedDaysAgo + 1),
      replyToHeader: {},
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Estimate",
      bodyText: "Hi Dana, it's $8,400 for the deck. Thanks, Davi",
      sentAt: daysAgo(quotedDaysAgo),
    },
  ]);
  return { threadId: t!.id, id };
}

async function inbound(
  threadId: string,
  gmailId: string,
  at: Date,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: gmailId,
    rfc822MessageId: `<${gmailId}@customer.com>`,
    direction: "in",
    fromAddress: "dana@customer.com",
    fromName: "Dana Ruiz",
    subject: "Re: Estimate",
    bodyText: "text",
    sentAt: at,
    replyToHeader: {},
    ...over,
  });
}

describe("sorting an automatic reply", () => {
  it("no model call; the conversation keeps its kind and the customer's email is still the one sorted", async () => {
    const { threadId } = await quoted(5);
    await inbound(threadId, "oof", daysAgo(4), {
      autoReply: true,
      subject: "Automatic reply: Re: Estimate",
    });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    const r = await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    expect(r.classified).toBe(0);
    const [t] = await database.select().from(threads).where(eq(threads.id, threadId));
    expect(t!.category).toBe("quote_request");
    const [m] = await database.select().from(messages).where(eq(messages.gmailMessageId, "oof"));
    expect(m!.classifiedAt).toEqual(NOW);
  });

  it("an automatic reply alone (to the owner's new email) is noise", async () => {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: "lonely", inInbox: true })
      .returning();
    await inbound(t!.id, "oof2", daysAgo(1), { autoReply: true });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    const [after] = await database.select().from(threads).where(eq(threads.id, t!.id));
    expect(after!.category).toBe("noise");
  });
});

describe("drafting and autopilot never answer a robot", () => {
  it("a job skips a conversation whose newest email is an automatic reply; the owner's tap still drafts", async () => {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "ask",
        inInbox: true,
        category: "customer_question",
        classifiedAt: NOW,
      })
      .returning();
    await inbound(t!.id, "q1", daysAgo(2), { bodyText: "Do you do decks?" });
    await inbound(t!.id, "oof3", daysAgo(1), { autoReply: true, bodyText: "I'm away." });
    const r = await createDraftForThread(t!.id, { trigger: "auto", ...deps() });
    expect(r).toEqual({ status: "skipped", reason: "auto_reply" });
    expect(writer.calls).toEqual([]);
  });

  it("autopilot refuses an automatic reply", () => {
    expect(
      guardrailReasons({
        category: "customer_question",
        needsOwner: false,
        kind: "reply",
        confidencePct: 95,
        flags: [],
        amountsInEmail: [],
        draftBody: "Thanks, see you then.",
        knownCustomer: true,
        purpose: null,
        autoReply: true,
      }),
    ).toEqual(["That was an automatic reply, so it waits for you."]);
  });
});

describe("follow-ups after an acknowledgement, an automatic reply or a bounce (Check 21 P1)", () => {
  it('quote, then "Thanks, we\'ll look it over": nudge after the wait, to Dana, threaded to her email; a later question stops it', async () => {
    const { threadId, id } = await quoted(10);
    await inbound(threadId, `${id}-ack`, daysAgo(4), {
      ackOnly: true,
      bodyText: "Thanks, got it. We'll look it over and get back to you.",
    });
    // The wait (3 days) counts from her acknowledgement, not from the quote.
    expect(await threadsToFollowUp(mailboxId, daysAgo(2))).toEqual([]);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([threadId]);
    // No reply is ever auto-drafted for a bare acknowledgement.
    expect(await threadsToAutoDraft(mailboxId)).toEqual([]);

    const { transport } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(threadId, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, threadId));
    expect(d).toMatchObject({ kind: "followup", toAddress: "dana@customer.com" });
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toContain(`In-Reply-To: <${id}-ack@customer.com>`);

    // A real question afterwards stops the chasing.
    await database.delete(drafts);
    await inbound(threadId, `${id}-q`, daysAgo(3.5), { bodyText: "Does that include the permit?" });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(await createDraftForThread(threadId, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "customer_replied",
    });
  });

  it("quote, then an out-of-office: nudge after the wait; no reply drafted for the auto-reply", async () => {
    const { threadId, id } = await quoted(5);
    await inbound(threadId, `${id}-oof`, daysAgo(5), {
      autoReply: true,
      subject: "Automatic reply: Re: Estimate",
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([threadId]);
    expect(await threadsToAutoDraft(mailboxId)).toEqual([]);
    const { transport } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(threadId, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toContain(`In-Reply-To: <${id}-out@shop.com>`);
  });

  it("quote, then a mailer-daemon bounce: no nudge, the bounce is marked and the card says so", async () => {
    const fake = new FakeMailbox();
    const at = (d: number) => ({ now: NOW, daysAgo: d });
    fake.add({
      id: "req",
      threadId: "tb",
      ...at(6),
      headers: { from: "Dana <dana@customer.com>", to: "owner@shop.com", subject: "Estimate" },
    });
    fake.add({
      id: "quote",
      threadId: "tb",
      labelIds: ["SENT"],
      ...at(5),
      headers: { from: "owner@shop.com", to: "dana@customr.com", subject: "Re: Estimate" },
    });
    await runBackfill(mailboxId, { readerFor: () => fake.reader(), now: () => NOW });
    fake.add({
      id: "bounce",
      threadId: "tb",
      ...at(4.9),
      headers: {
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        to: "owner@shop.com",
        subject: "Delivery Status Notification (Failure)",
      },
    });
    await incrementalSync(mailboxId, { readerFor: () => fake.reader(), now: () => NOW });
    const [t] = await database.select().from(threads).where(eq(threads.gmailThreadId, "tb"));
    await database
      .update(threads)
      .set({ category: "quote_request", classifiedAt: daysAgo(5.5) })
      .where(eq(threads.id, t!.id));
    expect((t!.extracted as { bounced?: boolean }).bounced).toBe(true);
    expect(bouncedLine(t!.extracted)).toBe(BOUNCED_LINE);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(await createDraftForThread(t!.id, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "bounced",
    });
    // The owner writes again (a corrected address): the mark goes.
    fake.add({
      id: "again",
      threadId: "tb",
      labelIds: ["SENT"],
      ...at(1),
      headers: { from: "owner@shop.com", to: "dana@customer.com", subject: "Re: Estimate" },
    });
    await incrementalSync(mailboxId, { readerFor: () => fake.reader(), now: () => NOW });
    const [after] = await database.select().from(threads).where(eq(threads.id, t!.id));
    expect(bouncedLine(after!.extracted)).toBeNull();
  });

  it('quote, nudge 1, then her "Thanks!": nudge 2 still comes', async () => {
    const { threadId, id } = await quoted(12);
    await database.insert(drafts).values({
      threadId,
      mailboxId,
      kind: "followup",
      toAddress: "dana@customer.com",
      subject: "Re: Estimate",
      body: "nudge",
      status: "sent",
      reason: "nudge",
      createdAt: daysAgo(8.1),
      decidedAt: daysAgo(8),
    });
    await database.insert(messages).values({
      threadId,
      mailboxId,
      gmailMessageId: `${id}-n1`,
      rfc822MessageId: `<${id}-n1@shop.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      bodyText: "nudge",
      sentAt: daysAgo(8),
    });
    await inbound(threadId, `${id}-thx`, daysAgo(7), { ackOnly: true, bodyText: "Thanks!" });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([threadId]);
    const { transport } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(threadId, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
  });

  it("a real question after the quote stops nudges and gets a reply draft", async () => {
    const { threadId, id } = await quoted(6);
    await inbound(threadId, `${id}-q`, daysAgo(5), { bodyText: "Does that include the permit?" });
    await database
      .update(threads)
      .set({ category: "quote_request", classifiedAt: daysAgo(4.9) })
      .where(eq(threads.id, threadId));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(await threadsToAutoDraft(mailboxId)).toEqual([threadId]);
  });

  it("no header value or body text in any log line", async () => {
    const logs: unknown[] = [];
    for (const k of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a));
    const fake = new FakeMailbox();
    fake.add({
      id: "o1",
      threadId: "tl",
      headers: {
        from: "Dana <dana@customer.com>",
        to: "owner@shop.com",
        subject: "Automatic reply: Re: Estimate",
        autoSubmitted: "auto-replied; owner-email=dana@customer.com",
      },
      bodyText: "I'm away until Monday",
    });
    await runBackfill(mailboxId, { readerFor: () => fake.reader(), now: () => NOW });
    const { transport } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    const text = JSON.stringify(logs);
    for (const secret of ["auto-replied", "dana@customer.com", "away until Monday", "Automatic"])
      expect(text).not.toContain(secret);
  });
});
