import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { activityLog, businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  createDraftForThread,
  reconcileDrafts,
  sendDraft,
  sentDraftSummary,
} from "@/server/drafts";
import { digestCounts } from "@/server/digest";
import { localDayStart } from "@/server/growth-client-rules";
import { followupScanDue, markFollowupScanned, threadsToFollowUp } from "@/server/followups";
import { localParts } from "@/server/snooze-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { followupSettingsInput, saveFollowupSettings } from "@/server/profile";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-05T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const nudge = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nJust checking you got the quote for the panel upgrade. Any questions, shout.\n\nThanks, Davi",
  reason: "No reply in 4 days to your panel upgrade quote. Gentle nudge.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

/** A customer asked; the owner answered `ownerRepliedDaysAgo` days ago; nothing since. */
async function quietThread(
  opts: {
    category?: string;
    needsOwner?: boolean;
    needsOwnerManual?: boolean;
    extracted?: Record<string, unknown>;
    complainedAt?: Date;
    ownerRepliedDaysAgo?: number;
    customerWroteAfter?: boolean;
  } = {},
) {
  const id = `g${++g}`;
  const replied = opts.ownerRepliedDaysAgo ?? 4;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Panel upgrade",
      category: opts.category ?? "quote_request",
      needsOwner: opts.needsOwner ?? false,
      needsOwnerManual: opts.needsOwnerManual ?? false,
      ...(opts.extracted ? { extracted: opts.extracted } : {}),
      ...(opts.complainedAt ? { complainedAt: opts.complainedAt } : {}),
      summary: "Dana wants a panel upgrade quote.",
      classifiedAt: daysAgo(replied + 1),
      lastMessageAt: daysAgo(replied),
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
      subject: "Panel upgrade",
      bodyText: "Can you quote a 200 amp panel upgrade?",
      sentAt: daysAgo(replied + 1),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      references: `<${id}-in@customer.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Panel upgrade",
      bodyText: "Hi Dana, it's $2,400 including the permit. Thanks, Davi",
      sentAt: daysAgo(replied),
    },
  ]);
  if (opts.customerWroteAfter) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in2`,
      direction: "in",
      fromAddress: "dana@customer.com",
      bodyText: "Thanks, thinking about it.",
      sentAt: daysAgo(replied - 1),
    });
  }
  return t!.id;
}

async function sentNudge(threadId: string, createdDaysAgo: number) {
  await database.insert(drafts).values({
    threadId,
    mailboxId,
    kind: "followup",
    gmailDraftId: `old-${threadId}-${createdDaysAgo}`,
    toAddress: "dana@customer.com",
    subject: "Re: Panel upgrade",
    body: "nudge",
    originalBody: "nudge",
    status: "sent",
    reason: "nudge",
    promptVersion: "followup.v2",
    // Drafted a little before it went out.
    createdAt: daysAgo(createdDaysAgo + 0.1),
    decidedAt: daysAgo(createdDaysAgo),
  });
  // The sent nudge shows up in Gmail as the owner's latest message.
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `${threadId}-nudge-${createdDaysAgo}`,
    rfc822MessageId: `<${threadId}-nudge@shop.com>`,
    direction: "out",
    fromAddress: "owner@shop.com",
    subject: "Re: Panel upgrade",
    bodyText: "nudge",
    sentAt: daysAgo(createdDaysAgo),
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
  writer = new FakeWriter();
});

describe("which threads get a nudge", () => {
  it("a quote the owner answered 3+ days ago with no reply is due", async () => {
    const due = await quietThread({ ownerRepliedDaysAgo: 4 });
    await quietThread({ ownerRepliedDaysAgo: 1 }); // too soon
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([due]);
  });

  it("invoices count; complaints, other categories and flagged threads never do", async () => {
    const invoice = await quietThread({ category: "invoice_payment" });
    await quietThread({ category: "complaint" });
    await quietThread({ category: "customer_question" });
    await quietThread({ needsOwner: true });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([invoice]);
  });

  it("not if the customer has written since", async () => {
    await quietThread({ ownerRepliedDaysAgo: 5, customerWroteAfter: true });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("an unsent Gmail draft (DRAFT label) isn't the owner writing last", async () => {
    const draftRow = (threadId: string, at: Date) =>
      database.insert(messages).values({
        threadId,
        mailboxId,
        gmailMessageId: `${threadId}-draft`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@customer.com"],
        labelIds: ["DRAFT"],
        sentAt: at,
      });
    // The customer asked; the owner only ever drafted an answer: nothing to chase.
    const [onlyDrafted] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `g${++g}`,
        inInbox: true,
        category: "quote_request",
        classifiedAt: daysAgo(9),
        lastMessageAt: daysAgo(4),
      })
      .returning();
    await database.insert(messages).values({
      threadId: onlyDrafted!.id,
      mailboxId,
      gmailMessageId: `${onlyDrafted!.id}-in`,
      direction: "in",
      fromAddress: "dana@customer.com",
      sentAt: daysAgo(10),
    });
    await draftRow(onlyDrafted!.id, daysAgo(4));
    // The owner answered 4 days ago and started a draft yesterday: still due from the answer.
    const answered = await quietThread({ ownerRepliedDaysAgo: 4 });
    await draftRow(answered, daysAgo(1));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([answered]);
  });

  it('a lead only forwarded to the crew was never quoted: no "following up on my quote" nudge', async () => {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `g${++g}`,
        inInbox: true,
        subject: "Panel upgrade",
        category: "quote_request",
        classifiedAt: daysAgo(9),
        lastMessageAt: daysAgo(4),
      })
      .returning();
    await database.insert(messages).values([
      {
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${t!.id}-in`,
        direction: "in",
        fromAddress: "dana@customer.com",
        subject: "Panel upgrade",
        sentAt: daysAgo(5),
      },
      {
        // Gmail keeps the forward in the customer's conversation.
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${t!.id}-fwd`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["crew@shop.com"],
        labelIds: ["SENT"],
        subject: "Fwd: Panel upgrade",
        sentAt: daysAgo(4),
      },
    ]);
    // A quote the owner did send, then forwarded to the crew: still chased from the quote.
    const quoted = await quietThread({ ownerRepliedDaysAgo: 4 });
    await database.insert(messages).values({
      threadId: quoted,
      mailboxId,
      gmailMessageId: `${quoted}-fwd`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["crew@shop.com"],
      subject: "Fwd: Panel upgrade",
      sentAt: daysAgo(3.5),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([quoted]);
  });

  it("not if it went quiet weeks ago", async () => {
    await quietThread({ ownerRepliedDaysAgo: 30 });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("never more than two nudges, ever", async () => {
    const once = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(once, 6);
    const twice = await quietThread({ ownerRepliedDaysAgo: 12 });
    await sentNudge(twice, 8);
    await sentNudge(twice, 4);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([once]);
  });

  it("a nudge the owner discarded isn't written again until they write again", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 5 });
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      kind: "followup",
      gmailDraftId: "discarded",
      toAddress: "dana@customer.com",
      subject: "Re",
      body: "x",
      originalBody: "x",
      status: "discarded",
      reason: "x",
      promptVersion: "followup.v2",
      createdAt: daysAgo(1),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("follows the owner's settings: off, or a different wait", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    await saveFollowupSettings(workspaceId, followupSettingsInput.parse({ days: "5" }));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    await saveFollowupSettings(
      workspaceId,
      followupSettingsInput.parse({ enabled: "on", days: "3" }),
    );
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
    await saveFollowupSettings(workspaceId, followupSettingsInput.parse({ days: "3" }));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("rejects a wait that isn't one of the choices", () => {
    expect(followupSettingsInput.safeParse({ enabled: "on", days: "1" }).success).toBe(false);
    expect(followupSettingsInput.safeParse({ days: "30" }).success).toBe(false);
  });
});

describe("big invoices are chased too (Check 12 P1)", () => {
  const bigInvoice = (over: Record<string, unknown> = {}) => ({
    category: "invoice_payment",
    needsOwner: true,
    extracted: {
      invoice: { invoice_number: "1043", amount: 5000, due_date: null, status: "unpaid" },
      invoice_thread: true,
      dollar_amounts: [5000],
      owner_rule_hits: ["amount", "model"],
      owner_code: "amount",
      ...over,
    },
  });

  it("an unpaid $5,000 invoice that needs you only for its size is picked and drafted", async () => {
    const t = await quietThread(bigInvoice());
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    expect(r.status).toBe("created");
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    // A draft that waits for the owner's tap, never a send.
    expect(d).toMatchObject({ kind: "followup", status: "pending" });
    expect(writer.sent).toHaveLength(0);
  });

  it("not when the owner marked it, or with a dispute or a complaint", async () => {
    const manual = await quietThread({ ...bigInvoice(), needsOwnerManual: true });
    const dispute = await quietThread(
      bigInvoice({ owner_rule_hits: ["dispute", "amount"], disputed: true }),
    );
    const complained = await quietThread({ ...bigInvoice(), complainedAt: daysAgo(30) });
    const other = await quietThread(bigInvoice({ owner_rule_hits: ["amount", "vip"] }));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    setModelTransportForTests(fakeTransport([nudge(), nudge(), nudge(), nudge()]).transport);
    for (const t of [manual, dispute, complained, other]) {
      expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
        status: "skipped",
        reason: "followup_not_allowed",
      });
    }
  });

  it("the sent screen promises the next nudge on a big invoice, as the scan will do", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread(bigInvoice());
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await sendDraft(workspaceId, r.draftId, deps());
    const summary = await sentDraftSummary(workspaceId, r.draftId);
    expect(summary!.nudgeOn).not.toBeNull();
  });

  it("a $5,000 quote request still waits on the owner", async () => {
    const t = await quietThread({
      category: "quote_request",
      needsOwner: true,
      extracted: { dollar_amounts: [5000], owner_rule_hits: ["amount"], owner_code: "amount" },
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toMatchObject({
      status: "skipped",
    });
  });
});

describe("writing and sending a nudge", () => {
  it("is a real Gmail draft to the customer, threaded after the owner's message, using the follow-up prompt", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);

    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    expect(r.status).toBe("created");
    expect(calls[0]!.system[0]!.text).toMatch(/follow-up/i);
    expect(calls[0]!.user).toMatch(/hasn't replied for 4 days/);

    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d).toMatchObject({
      kind: "followup",
      toAddress: "dana@customer.com",
      status: "pending",
    });
    expect(d!.promptVersion).toBe("followup.v4");
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toMatch(/In-Reply-To: <g\d+-out@shop.com>/);
    expect(FakeWriter.headersOf(raw)).toMatch(/To: dana@customer.com/);
    // Repeating a price already in the conversation isn't flagged as invented.
    expect(d!.flags).toEqual([]);

    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "followup_drafted"));
    expect(log!.detail).toMatchObject({ nudgeNumber: 1 });
    expect(JSON.stringify(log!.detail)).not.toMatch(/Dana|panel|2,400/i);
  });

  it("after a forward to the crew and the crew's reply, the scan and the nudge agree: to the customer, threaded to the quote", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    await database.insert(messages).values([
      {
        threadId: t,
        mailboxId,
        gmailMessageId: `${t}-fwd`,
        rfc822MessageId: `<${t}-fwd@shop.com>`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["crew@shop.com"],
        subject: "Fwd: Panel upgrade",
        bodyText: "SECRET-CREW can you check the panel size?",
        sentAt: daysAgo(3.9),
      },
      {
        threadId: t,
        mailboxId,
        gmailMessageId: `${t}-crew`,
        rfc822MessageId: `<${t}-crew@shop.com>`,
        direction: "in",
        fromAddress: "crew@shop.com",
        toAddresses: ["owner@shop.com"],
        subject: "Re: Fwd: Panel upgrade",
        bodyText: "SECRET-CREW 200 amp is fine, $2,000 would be my price",
        sentAt: daysAgo(3.8),
      },
    ]);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);

    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t, { trigger: "followup", ...deps() })).status).toBe(
      "created",
    );
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d!.toAddress).toBe("dana@customer.com");
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toMatch(/In-Reply-To: <g\d+-out@shop.com>/);
    // Quiet since the quote (4 days), and the crew's talk is never shown to the model.
    expect(calls[0]!.user).toMatch(/hasn't replied for 4 days/);
    expect(calls[0]!.user).not.toMatch(/SECRET-CREW/);
  });

  it("a newer unsent Gmail draft is skipped: threaded to the sent email, its text never shown to the model", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    // Stored by the old sync: the owner's draft, never sent, with a figure in it.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "unsent",
      rfc822MessageId: "<unsent@shop.com>",
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      labelIds: ["DRAFT"],
      bodyText: "SECRET-UNSENT maybe $1,950 if you book this week",
      sentAt: daysAgo(1),
    });
    const { transport, calls } = fakeTransport([
      nudge({ body: "Hi Dana, still happy to do it for $1,950. Thanks, Davi" }),
      nudge({ body: "Hi Dana, still happy to do it for $1,950. Thanks, Davi" }),
    ]);
    setModelTransportForTests(transport);

    expect((await createDraftForThread(t, { trigger: "followup", ...deps() })).status).toBe(
      "created",
    );
    expect(JSON.stringify(calls)).not.toContain("SECRET-UNSENT");
    // 4 days quiet since the email the customer got, not 1 since the draft.
    expect(calls[0]!.user).toMatch(/hasn't replied for 4 days/);
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toMatch(/In-Reply-To: <g\d+-out@shop.com>/);
    expect(FakeWriter.headersOf(raw)).not.toContain("unsent@shop.com");
    // The unsent figure isn't a fact the owner gave: it's flagged, not taken as source.
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d!.flags.join(" ")).toContain("$1,950");
  });

  it("the second nudge is the last, and offers an easy out", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(t, 4);
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t, { trigger: "followup", ...deps() })).status).toBe(
      "created",
    );
    expect(calls[0]!.user).toMatch(/second and final follow-up/);
  });

  it("the cap holds even if something asks directly", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 12 });
    await sentNudge(t, 8);
    await sentNudge(t, 4);
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_cap",
    });
    const complaint = await quietThread({ category: "complaint" });
    expect(await createDraftForThread(complaint, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    const answered = await quietThread({ customerWroteAfter: true });
    expect(await createDraftForThread(answered, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "customer_replied",
    });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("a nudge is never sent during evaluation, like any other draft", async () => {
    const t = await quietThread();
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await expect(sendDraft(workspaceId, r.draftId, deps())).rejects.toThrow(/blocked/);
    expect(writer.sent).toEqual([]);
  });

  it("sending counts toward the cap, and the sent screen says what's next", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");

    const sent = await sendDraft(workspaceId, r.draftId, deps());
    expect(sent).toMatchObject({ status: "sent", toName: "Dana Ruiz" });
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(1);

    const summary = await sentDraftSummary(workspaceId, r.draftId);
    expect(summary!.kind).toBe("followup");
    // Check 21 P3: the owner's calendar day (Eastern by default), ready that morning.
    expect(summary!.nudgeOn).toEqual(new Date("2026-10-08T04:00:00Z"));
    expect(summary!.lastNudgeUsed).toBe(false);
  });

  it("after the second nudge, the sent screen says that was the last one", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(t, 4);
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await sendDraft(workspaceId, r.draftId, deps());
    const summary = await sentDraftSummary(workspaceId, r.draftId);
    expect(summary).toMatchObject({ nudgeOn: null, lastNudgeUsed: true });
  });

  it("a pending nudge is withdrawn if the owner writes to them some other way", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "owner-wrote-again",
      direction: "out",
      fromAddress: "owner@shop.com",
      bodyText: "Called you, left a voicemail.",
      sentAt: new Date(NOW.getTime() + 3600_000),
    });
    const later = { writerFor: () => writer, now: () => new Date(NOW.getTime() + 7200_000) };
    expect((await reconcileDrafts(mailboxId, later)).closed).toBe(1);
    const [d] = await database.select().from(drafts).where(eq(drafts.id, r.draftId));
    expect(d!.status).toBe("expired");
    expect(writer.drafts.size).toBe(0);
  });

  it("read-only accounts get no nudges", async () => {
    const t = await quietThread();
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "read_only",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("a decided quote is never chased (plan #30, amendment A3)", () => {
  const decide = (threadId: string, outcome: string, source: "owner" | "auto") =>
    database
      .update(threads)
      .set({ quoteOutcome: outcome, quoteOutcomeSource: source, quoteOutcomeAt: daysAgo(1) })
      .where(eq(threads.id, threadId));

  it.each([
    ["won by the owner", "won", "owner"],
    ["won — our guess", "won", "auto"],
    ["lost", "lost", "owner"],
    ["no answer — our guess", "no_answer", "auto"],
  ] as const)("%s → no nudge, even if asked directly", async (_l, outcome, source) => {
    const open = await quietThread({ ownerRepliedDaysAgo: 4 });
    const decided = await quietThread({ ownerRepliedDaysAgo: 4 });
    await decide(decided, outcome, source);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([open]);

    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(decided, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("a won job's invoice is still chased; a lost one's isn't", async () => {
    const won = await quietThread({ category: "invoice_payment", ownerRepliedDaysAgo: 4 });
    const lost = await quietThread({ category: "invoice_payment", ownerRepliedDaysAgo: 4 });
    await decide(won, "won", "auto");
    await decide(lost, "lost", "owner");
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([won]);

    const { transport } = fakeTransport([nudge(), nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(won, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
    expect(await createDraftForThread(lost, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
  });

  it("decided while the nudge was being written → no nudge, and no Gmail draft left behind", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    const { transport } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    const create = writer.createDraft.bind(writer);
    writer.createDraft = async (input) => {
      const made = await create(input);
      // The owner taps Lost on Quotes while we're saving the draft.
      await decide(t, "lost", "owner");
      return made;
    };
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    expect(writer.calls).toEqual(["createDraft", "deleteDraft"]);
    expect(writer.drafts.size).toBe(0);
    expect(await database.select().from(drafts).where(eq(drafts.threadId, t))).toEqual([]);
    const logged = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "followup_drafted"));
    expect(logged).toEqual([]);
  });

  it("a reopened quote is chased again", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    await database
      .update(threads)
      .set({ quoteOutcome: null, quoteOutcomeSource: "owner" })
      .where(eq(threads.id, t));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
  });

  it("the sent screen promises no nudge on a won quote", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(t, 4); // one nudge used, so "the last one" can't be claimed either
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t,
        mailboxId,
        gmailDraftId: "sent-reply",
        toAddress: "dana@customer.com",
        subject: "Re: Panel upgrade",
        body: "See you Monday.",
        originalBody: "See you Monday.",
        status: "sent",
        reason: "reply",
        promptVersion: "draft.v5",
        decidedAt: NOW,
      })
      .returning();
    const before = await sentDraftSummary(workspaceId, d!.id);
    expect(before!.nudgeOn).not.toBeNull();
    await decide(t, "won", "auto");
    const summary = await sentDraftSummary(workspaceId, d!.id);
    expect(summary).toMatchObject({ nudgeOn: null, lastNudgeUsed: false });
  });
});

describe("nudges by the owner's calendar day, ready by 5am (Check 21 P3)", () => {
  const at = (date: string, hm: string, tz: string) => {
    const [h, m] = hm.split(":").map(Number) as [number, number];
    return new Date(localDayStart(date, tz).getTime() + (h * 60 + m) * 60_000);
  };
  async function owner(tz: string, days: number) {
    await database
      .insert(businessProfiles)
      .values({ workspaceId, timeZone: tz, followupDays: days })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: { timeZone: tz, followupDays: days },
      });
  }
  /** The owner's quote went out at `out` (sent from the app), after the customer asked. */
  async function quoteSentAt(out: Date) {
    const id = `c${++g}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: true,
        category: "quote_request",
        classifiedAt: new Date(out.getTime() - DAY),
        lastMessageAt: out,
      })
      .returning();
    await database.insert(messages).values([
      {
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-in`,
        direction: "in",
        fromAddress: "dana@customer.com",
        fromName: "Dana Ruiz",
        bodyText: "Quote please.",
        sentAt: new Date(out.getTime() - DAY),
      },
      {
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-out`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@customer.com"],
        bodyText: "It's $900.",
        sentAt: out,
      },
    ]);
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId,
        kind: "reply",
        gmailDraftId: `gd-${id}`,
        toAddress: "dana@customer.com",
        subject: "Re: Quote",
        body: "It's $900.",
        originalBody: "It's $900.",
        status: "sent",
        reason: "reply",
        promptVersion: "draft.v8",
        createdAt: new Date(out.getTime() - 60_000),
        decidedAt: out,
      })
      .returning();
    return { threadId: t!.id, draftId: d!.id };
  }
  /** The first local date (4am scans, day by day) on which the scan picks the thread. */
  async function firstPick(threadId: string, from: string, tz: string) {
    for (let i = 0; i < 10; i++) {
      const date = new Date(Date.parse(`${from}T12:00:00Z`) + i * DAY).toISOString().slice(0, 10);
      if ((await threadsToFollowUp(mailboxId, at(date, "04:00", tz), 50)).includes(threadId))
        return date;
    }
    return null;
  }

  it.each([
    ["Friday 2:00pm, 3-day wait", "America/New_York", 3, "2026-10-23", "14:00", "2026-10-26"],
    ["Wednesday 10:00am, 3-day wait", "America/New_York", 3, "2026-10-21", "10:00", "2026-10-24"],
    ["Thursday 4:00pm, 2-day wait", "America/New_York", 2, "2026-10-22", "16:00", "2026-10-24"],
    ["Los Angeles Monday 7:00pm", "America/Los_Angeles", 3, "2026-10-19", "19:00", "2026-10-22"],
  ] as const)(
    "%s: the sent screen's day is the day the scan first picks it",
    async (_l, tz, days, date, hm, expected) => {
      await owner(tz, days);
      const { threadId, draftId } = await quoteSentAt(at(date, hm, tz));
      const summary = await sentDraftSummary(workspaceId, draftId, at(date, hm, tz));
      expect(localParts(summary!.nudgeOn!, tz).date).toBe(expected);
      expect(await firstPick(threadId, date, tz)).toBe(expected);
    },
  );

  it("the scan runs once per owner per local day, at 4am their time", async () => {
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    await owner("America/Los_Angeles", 3);
    const ids = (r: Awaited<ReturnType<typeof followupScanDue>>) => r.map((w) => w.workspaceId);
    // 4am Eastern is 1am in Los Angeles: not yet.
    expect(ids(await followupScanDue(at("2026-10-26", "04:30", "America/New_York")))).toEqual([]);
    const four = at("2026-10-26", "04:11", "America/Los_Angeles");
    const due = await followupScanDue(four);
    expect(ids(due)).toEqual([workspaceId]);
    expect(due[0]!.localDate).toBe("2026-10-26");
    await markFollowupScanned(workspaceId, due[0]!.localDate);
    // A retry in the same hour: nothing to do.
    expect(await followupScanDue(new Date(four.getTime() + 20 * 60_000))).toEqual([]);
    expect(await followupScanDue(at("2026-10-26", "05:11", "America/Los_Angeles"))).toEqual([]);
    expect(ids(await followupScanDue(at("2026-10-27", "04:11", "America/Los_Angeles")))).toEqual([
      workspaceId,
    ]);
  });

  it("a second scan the same morning drafts nothing, and the 7am morning email counts the nudge", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const tz = "America/New_York";
    await owner(tz, 3);
    const { threadId } = await quoteSentAt(at("2026-10-23", "14:00", tz));
    const four = at("2026-10-26", "04:11", tz);
    setModelTransportForTests(fakeTransport([nudge(), nudge()]).transport);
    const run = async (now: Date) => {
      let made = 0;
      for (const t of await threadsToFollowUp(mailboxId, now)) {
        const r = await createDraftForThread(t, {
          trigger: "followup",
          writerFor: () => writer,
          now: () => now,
        });
        if (r.status === "created") made++;
      }
      return made;
    };
    expect(await run(four)).toBe(1);
    expect(await run(new Date(four.getTime() + 15 * 60_000))).toBe(0);
    const nudges = await database.select().from(drafts).where(eq(drafts.threadId, threadId));
    expect(nudges.filter((d) => d.kind === "followup")).toHaveLength(1);
    const counts = await digestCounts(workspaceId, at("2026-10-26", "07:03", tz), tz);
    expect(counts.nudgesReady).toBe(1);
  });
});

describe("invoices the owner sends are chased (Check 21 P4)", () => {
  const won = async (threadId: string) =>
    database
      .update(threads)
      .set({ quoteOutcome: "won", quoteOutcomeSource: "owner", ownerInvoiceAt: daysAgo(4) })
      .where(eq(threads.id, threadId));

  it("a won quote, then the owner's invoice on a conversation sorted scheduling → reminder", async () => {
    const t = await quietThread({ category: "scheduling", extracted: { invoice_thread: true } });
    await won(t);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
  });

  it("the same with the conversation still sorted as a quote request → reminder", async () => {
    const t = await quietThread({ category: "quote_request", extracted: { invoice_thread: true } });
    await won(t);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
  });

  async function freshInvoice(to: string) {
    const id = `f${++g}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: false,
        subject: "Invoice 1043",
        extracted: { invoice_thread: true },
        ownerInvoiceAt: daysAgo(4),
        lastMessageAt: daysAgo(4),
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [to],
      subject: "Invoice 1043",
      snippet: "Invoice 1043 for the deck, $2,100. Thanks, Davi",
      sentAt: daysAgo(4),
    });
    return t!.id;
  }

  it("a fresh invoice email to an address that wrote before → reminder to that address; a stranger → none", async () => {
    await quietThread({ category: "customer_question", customerWroteAfter: true }); // Dana wrote
    const known = await freshInvoice("Dana@Customer.com");
    const stranger = await freshInvoice("typo@custmer.com");
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([known]);
    const logs: unknown[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a)),
    );
    setModelTransportForTests(fakeTransport([nudge(), nudge()]).transport);
    expect(await createDraftForThread(known, { trigger: "followup", ...deps() })).toMatchObject({
      status: "created",
    });
    expect(await createDraftForThread(stranger, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "no_text",
    });
    for (const s of spies) s.mockRestore();
    expect(JSON.stringify(logs)).not.toMatch(/1043|2,100|dana@|typo@/i);
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, known));
    expect(d).toMatchObject({
      kind: "followup",
      toAddress: "dana@customer.com",
      status: "pending",
    });
  });

  it("a bill the owner owes is never chased, and a paid mark still stops it", async () => {
    const owed = await quietThread({
      category: "invoice_payment",
      extracted: { invoice_thread: true, bill_direction: "owed_by_business" },
    });
    const paid = await quietThread({ category: "scheduling", extracted: { invoice_thread: true } });
    await database
      .update(threads)
      .set({ invoicePaidAt: daysAgo(1), invoicePaidSource: "owner" })
      .where(eq(threads.id, paid));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    setModelTransportForTests(fakeTransport([nudge(), nudge()]).transport);
    for (const t of [owed, paid])
      expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
        status: "skipped",
        reason: "followup_not_allowed",
      });
  });
});
