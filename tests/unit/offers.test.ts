import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests, type Transport } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import {
  countSentFollowups,
  createDraftForThread,
  discardDraft,
  sendDraft,
  sentDraftSummary,
} from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { listMoney } from "@/server/money";
import {
  closingQuestionReason,
  isAutomatedSender,
  reviewOfferReason,
  type ClosingFacts,
  type ReviewFacts,
} from "@/server/offer-rules";
import { closingQuestionAllowed, reviewAllowed, threadOffers } from "@/server/offers";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { lockReviewAddress } from "@/server/review-lock";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

// The real lock, wrapped so a test can prove the create path takes it (A16). PGlite runs one
// transaction at a time, so a race test alone would still pass without the lock.
vi.mock("@/server/review-lock", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/review-lock")>();
  return { ...real, lockReviewAddress: vi.fn(real.lockReviewAddress) };
});

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T14:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REVIEW_URL = "https://g.page/r/elm-electric/review";
const DANA = "dana@customer.com";

const reviewBody = `Hi Dana,\n\nThanks again for having us. If you have a minute, a short review would mean a lot:\n${REVIEW_URL}\n\nDavi`;
const closingBody =
  "Hi Dana,\n\nDid you go another way, or did the timing change? Either is completely fine.\n\nDavi";
const reply = (body: string): ModelDraft => ({
  body,
  reason: "Owner asked.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = (when: Date = NOW) => ({ writerFor: () => writer, now: () => when });

async function setStatus(status: (typeof workspaces.$inferSelect)["status"]) {
  const paid = status === "setup_paid" || status === "active";
  await database
    .update(workspaces)
    .set({ status, setupPaidVia: paid ? "stripe" : null })
    .where(eq(workspaces.id, workspaceId));
}

async function profile(reviewUrl = REVIEW_URL) {
  await saveBusinessProfile(
    workspaceId,
    businessProfileInput.parse({
      businessName: "Elm Electric",
      trade: "electrical",
      services: "Panels",
      serviceArea: "",
      hours: "",
      leadTime: "",
      pricingNotes: "",
      paymentTerms: "",
      policies: "",
      signature: "Davi",
      reviewUrl,
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    }),
  );
}

type Msg = { direction: "in" | "out"; days: number; body?: string; from?: string };

async function makeThread(
  over: Partial<typeof threads.$inferInsert>,
  msgs: Msg[],
  customer = DANA,
  box = mailboxId,
) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box,
      gmailThreadId: id,
      inInbox: true,
      subject: "Panel upgrade",
      category: "customer_question",
      summary: "Dana says the job looks great.",
      extracted: { job_done: true },
      classifiedAt: NOW,
      lastMessageAt: at(Math.max(...msgs.map((m) => m.days))),
      ...over,
    })
    .returning();
  let n = 0;
  for (const m of msgs) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: box,
      gmailMessageId: `${id}-${++n}`,
      rfc822MessageId: `<${id}-${n}@mail.test>`,
      direction: m.direction,
      fromAddress: m.direction === "in" ? (m.from ?? customer) : "owner@shop.com",
      fromName: m.direction === "in" ? "Dana Ruiz" : null,
      toAddresses: m.direction === "out" ? [customer.toLowerCase()] : ["owner@shop.com"],
      subject: "Panel upgrade",
      bodyText: m.body ?? (m.direction === "in" ? "All done, looks great!" : "On it. Davi"),
      labelIds: ["INBOX"],
      sentAt: at(m.days),
    });
  }
  return t!.id;
}

/** A finished job: Dana asked, the owner replied, and Dana says it looks great. */
const jobDone = (over: Partial<typeof threads.$inferInsert> = {}, customer = DANA) =>
  makeThread(
    over,
    [
      { direction: "in", days: -10, body: "Can you swap the panel?" },
      { direction: "out", days: -9 },
      { direction: "in", days: -1 / 24 },
    ],
    customer,
  );

/**
 * A quote that went quiet after both nudges: quote, nudge 1, nudge 2 (12 days ago), no word
 * since. Exactly when the closing question may be asked.
 */
async function quietQuote(over: Partial<typeof threads.$inferInsert> = {}, lastOutDays = -12) {
  const t = await makeThread(
    {
      category: "quote_request",
      extracted: {},
      summary: "Dana wants a quote for a panel.",
      followupCount: 2,
      ...over,
    },
    [
      { direction: "in", days: -25, body: "How much for a 200 amp panel?" },
      { direction: "out", days: -22, body: "It's $3,100 including the permit. Davi" },
      { direction: "out", days: -18, body: "Just checking in on the quote. Davi" },
      { direction: "out", days: lastOutDays, body: "Any thoughts on the quote? Davi" },
    ],
  );
  for (const days of [-18, lastOutDays]) {
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      kind: "followup",
      status: "sent",
      toAddress: DANA,
      subject: "Re: Panel upgrade",
      body: "Just checking in.",
      reason: "Follow-up nudge.",
      createdAt: at(days),
      decidedAt: at(days),
    });
  }
  return t;
}

/** A review request already on file for an address (another thread). */
async function reviewOnFile(
  status: (typeof drafts.$inferInsert)["status"],
  days: number,
  to = DANA,
  sentDays = days,
) {
  const t = await jobDone({}, to.toLowerCase());
  await database.insert(drafts).values({
    threadId: t,
    mailboxId,
    kind: "reply",
    purpose: "review_request",
    status,
    toAddress: to,
    subject: "Re: Panel upgrade",
    body: `A review? ${REVIEW_URL}`,
    reason: "Review request.",
    createdAt: at(days),
    decidedAt: status === "pending" ? null : at(sentDays),
  });
}

const askReview = (t: string, when = NOW, ws = workspaceId) =>
  createDraftForThread(t, {
    trigger: "owner",
    workspaceId: ws,
    purpose: "review_request",
    ...deps(when),
  });
const askClosing = (t: string, when = NOW) =>
  createDraftForThread(t, {
    trigger: "owner",
    workspaceId,
    purpose: "closing_question",
    ...deps(when),
  });

function model(...bodies: string[]) {
  const { transport, calls } = fakeTransport(bodies.map(reply));
  setModelTransportForTests(transport);
  return calls;
}

async function draftRow(id: string) {
  return (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  delete process.env.FEATURE_CLOSING_QUESTION;
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
  await setStatus("active");
  writer = new FakeWriter();
  vi.mocked(lockReviewAddress).mockClear();
});
afterEach(() => {
  delete process.env.FEATURE_CLOSING_QUESTION;
  setModelTransportForTests(undefined);
});

describe("offer rules", () => {
  const review = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
    category: "customer_question",
    needsOwner: false,
    needsOwnerManual: false,
    complained: false,
    untrusted: false,
    jobDone: true,
    invoicePaid: false,
    customerAddress: DANA,
    ownerWroteToThem: true,
    reviewUrl: REVIEW_URL,
    recentReviewToAddress: false,
    ...over,
  });

  it("reviewOfferReason: complaint first, then the rest, null when allowed", () => {
    expect(reviewOfferReason(review())).toBeNull();
    // A complaint always says so, even when everything else is wrong too.
    expect(
      reviewOfferReason(
        review({ category: "complaint", needsOwner: true, jobDone: false, reviewUrl: null }),
      ),
    ).toBe("complaint");
    expect(reviewOfferReason(review({ complained: true }))).toBe("complaint");
    expect(reviewOfferReason(review({ needsOwnerManual: true }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ needsOwner: true }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ untrusted: true }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ jobDone: false }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ jobDone: false, invoicePaid: true }))).toBeNull();
    expect(reviewOfferReason(review({ category: "supplier_vendor" }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ category: "noise" }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ customerAddress: null }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ customerAddress: "receipts@stripe.com" }))).toBe(
      "not_eligible",
    );
    expect(reviewOfferReason(review({ ownerWroteToThem: false }))).toBe("not_eligible");
    expect(reviewOfferReason(review({ reviewUrl: null }))).toBe("no_review_link");
    expect(reviewOfferReason(review({ recentReviewToAddress: true }))).toBe("review_recent");
  });

  it("isAutomatedSender: receipts and no-reply senders, never a person", () => {
    for (const a of [
      "noreply@shop.test",
      "no-reply@shop.test",
      "No-Reply+abc@shop.test",
      "do-not-reply@shop.test",
      "donotreply@shop.test",
      "notifications@github.test",
      "notification@x.test",
      "MAILER-DAEMON@mx.test",
      "receipts@stripe.com",
      "billing@notification.intuit.com",
    ]) {
      expect(isAutomatedSender(a), a).toBe(true);
    }
    for (const a of ["dana@customer.com", "noreen@x.test", "replyguy@x.test", null, ""]) {
      expect(isAutomatedSender(a), String(a)).toBe(false);
    }
  });

  const closing = (over: Partial<ClosingFacts> = {}): ClosingFacts => ({
    featureOn: true,
    isQuoteThread: true,
    category: "quote_request",
    needsOwner: false,
    complained: false,
    outcome: null,
    sentNudges: 2,
    lastInboundAt: at(-25),
    lastOutboundAt: at(-7),
    askedBefore: false,
    ...over,
  });

  it("closingQuestionReason: off, one nudge, six days, won/lost, a reply, asked before", () => {
    expect(closingQuestionReason(closing(), NOW)).toBeNull();
    expect(closingQuestionReason(closing({ featureOn: false }), NOW)).toBe("feature_off");
    expect(closingQuestionReason(closing({ sentNudges: 1 }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ lastOutboundAt: at(-6) }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ outcome: "won" }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ outcome: "lost" }), NOW)).toBe("not_eligible");
    // "No answer" (ours or the owner's) is exactly when the question makes sense.
    expect(closingQuestionReason(closing({ outcome: "no_answer" }), NOW)).toBeNull();
    // The customer wrote after the last nudge.
    expect(closingQuestionReason(closing({ lastInboundAt: at(-3) }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ askedBefore: true }), NOW)).toBe("already_asked");
    expect(closingQuestionReason(closing({ isQuoteThread: false }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ needsOwner: true }), NOW)).toBe("not_eligible");
    expect(closingQuestionReason(closing({ category: "complaint" }), NOW)).toBe("complaint");
    expect(closingQuestionReason(closing({ complained: true }), NOW)).toBe("complaint");
    expect(closingQuestionReason(closing({ lastOutboundAt: null }), NOW)).toBe("not_eligible");
  });
});

describe("review request (#29)", () => {
  it("a finished job with a review link on file: offered, and the tap drafts it with the link", async () => {
    await profile();
    const t = await jobDone();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)).toEqual({
      review: true,
      closingQuestion: false,
      thankYou: false,
    });
    const calls = model(reviewBody);
    const r = await askReview(t);
    expect(r).toEqual({ status: "created", draftId: expect.any(String) });
    expect(calls[0]!.user).toContain("## Task: review request");
    expect(calls[0]!.user).toContain(REVIEW_URL);
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d).toMatchObject({ purpose: "review_request", kind: "reply", toAddress: DANA });
    // Waiting in the queue now, so it isn't offered again.
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
  });

  it("an invoice marked paid also makes it eligible; 'Not owed to me' doesn't", async () => {
    await profile();
    const paid = await jobDone({
      category: "invoice_payment",
      extracted: { invoice: { invoice_number: "41", amount: 900, status: "unpaid" } },
      invoicePaidAt: at(-1),
      invoicePaidSource: "owner",
    });
    const guessed = await jobDone(
      {
        category: "invoice_payment",
        extracted: { invoice: { invoice_number: "42", amount: 900, status: "paid" } },
        invoicePaidAt: at(-1),
        invoicePaidSource: "auto",
      },
      "sam@customer.com",
    );
    const notOwed = await jobDone(
      {
        category: "invoice_payment",
        extracted: { invoice: { invoice_number: "43", amount: 900, status: "unpaid" } },
        invoicePaidAt: at(-1),
        invoicePaidSource: "not_owed",
      },
      "lee@customer.com",
    );
    const open = await jobDone(
      { category: "invoice_payment", extracted: { invoice: { amount: 900, status: "unpaid" } } },
      "kim@customer.com",
    );
    const offers = await threadOffers(workspaceId, [paid, guessed, notOwed, open], NOW);
    expect(offers.get(paid)?.review).toBe(true);
    expect(offers.get(guessed)?.review).toBe(true);
    expect(offers.get(notOwed)?.review).toBe(false);
    expect(offers.get(open)?.review).toBe(false);
    expect(await reviewAllowed(workspaceId, notOwed, NOW)).toBe("not_eligible");
  });

  it("not offered while a draft waits on the thread or its newest text is gone", async () => {
    await profile();
    // "All done, looks great!" usually gets an ordinary reply drafted first.
    const waiting = await jobDone();
    await database.insert(drafts).values({
      threadId: waiting,
      mailboxId,
      kind: "reply",
      status: "pending",
      toAddress: DANA,
      subject: "Re: Panel upgrade",
      body: "Thanks Dana!",
      reason: "Reply drafted.",
      createdAt: NOW,
    });
    // Past retention: the purge nulled the bodies, so a tap could only fail with no_text.
    const purged = await jobDone({}, "sam@customer.com");
    await database
      .update(messages)
      .set({ bodyText: null, snippet: null })
      .where(eq(messages.threadId, purged));
    const offers = await threadOffers(workspaceId, [waiting, purged], NOW);
    expect(offers.get(waiting)?.review).toBe(false);
    expect(offers.get(purged)?.review).toBe(false);
    // The server rule itself is unchanged: the tap still ends at the same checks.
    const calls = model(reviewBody);
    expect(await askReview(waiting)).toEqual({ status: "skipped", reason: "already_pending" });
    expect(await askReview(purged)).toEqual({ status: "skipped", reason: "no_text" });
    expect(calls).toHaveLength(0);
  });

  it("no link on file: not offered, and a tap says so before any model call", async () => {
    await profile("");
    const t = await jobDone();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "no_review_link" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });
});

describe("GUARDRAIL: never to complaint threads (server-side)", () => {
  it("a complaint thread with job_done → skipped complaint, no model call, no Gmail draft", async () => {
    await profile();
    const t = await jobDone({ category: "complaint", needsOwner: true });
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
    expect(await database.select().from(drafts)).toEqual([]);
  });

  it("complaints are sticky (A1): a later 'looks great' on the same thread still can't get one", async () => {
    await profile();
    const t = await makeThread({ category: null, extracted: null, classifiedAt: null }, [
      { direction: "in", days: -6, body: "The breaker keeps tripping. This is unacceptable." },
    ]);
    setModelTransportForTests(
      fakeTransport([classification({ category: "complaint", summary: "Breaker trips." })])
        .transport,
    );
    await classifyPending(mailboxId, { now: at(-6) });
    const [first] = await database.select().from(threads).where(eq(threads.id, t));
    expect(first!.category).toBe("complaint");
    expect(first!.complainedAt).toEqual(at(-6));

    // The owner fixed it; Dana writes back happy. Re-sorted as an ordinary question.
    for (const [n, direction, days, body] of [
      ["fix", "out", -5, "Sorry about that — I'll come back tomorrow. Davi"],
      ["happy", "in", -1, "Fixed now, looks great. Thanks!"],
    ] as const) {
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: `${t}-${n}`,
        direction,
        fromAddress: direction === "in" ? DANA : "owner@shop.com",
        toAddresses: direction === "out" ? [DANA] : ["owner@shop.com"],
        subject: "Breaker",
        bodyText: body,
        labelIds: ["INBOX"],
        sentAt: at(days),
      });
    }
    setModelTransportForTests(
      fakeTransport([
        classification({
          category: "customer_question",
          summary: "Dana says it's fixed.",
          signals: { ...classification().signals, job_done: true },
        }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [later] = await database.select().from(threads).where(eq(threads.id, t));
    expect(later!.category).toBe("customer_question");
    expect(later!.extracted).toMatchObject({ job_done: true });
    // Never cleared, and a non-complaint doesn't move it.
    expect(later!.complainedAt).toEqual(at(-6));

    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  /** A new inbound email on thread `t`, then one classification of it by the stand-in model. */
  async function resort(
    t: string,
    days: number,
    body: string,
    as: ReturnType<typeof classification>,
  ) {
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `${t}-${days}`,
      direction: "in",
      fromAddress: DANA,
      toAddresses: ["owner@shop.com"],
      subject: "Breaker",
      bodyText: body,
      labelIds: ["INBOX"],
      sentAt: at(days),
    });
    setModelTransportForTests(fakeTransport([as]).transport);
    await classifyPending(mailboxId, { now: at(days) });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    return row!;
  }
  const happy = () =>
    classification({
      category: "customer_question",
      summary: "Dana says it's fixed.",
      signals: { ...classification().signals, job_done: true },
    });

  it("a complaint sorted before the sticky mark existed (legacy) still blocks, on that thread and others", async () => {
    await profile();
    // Sorted as a complaint by older code: no complained_at.
    const t = await makeThread(
      { category: "complaint", needsOwner: true, extracted: {}, classifiedAt: at(-6) },
      [
        { direction: "in", days: -6, body: "The breaker keeps tripping. This is unacceptable." },
        { direction: "out", days: -5, body: "Sorry — back tomorrow. Davi" },
      ],
    );
    await database
      .update(messages)
      .set({ classifiedAt: at(-6) })
      .where(eq(messages.threadId, t));
    const later = await resort(t, -1 / 24, "Fixed now, looks great. Thanks!", happy());
    expect(later.category).toBe("customer_question");
    // The earlier sort counts: the mark comes from when it was sorted as a complaint.
    expect(later.complainedAt).toEqual(at(-6));

    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    const other = await jobDone();
    expect(await reviewAllowed(workspaceId, other, NOW)).toBe("complaint");
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("a legacy complaint thread that was never re-sorted blocks the customer's other threads", async () => {
    await profile();
    await jobDone({ category: "complaint", needsOwner: true, complainedAt: null });
    const t = await jobDone();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("complaint");
  });

  it("the 12 months count from the LATEST complaint, not the first", async () => {
    await profile();
    const t = await makeThread(
      {
        category: "customer_question",
        extracted: {},
        complainedAt: at(-400),
        classifiedAt: at(-300),
      },
      [{ direction: "out", days: -20, body: "Checking the panel next week. Davi" }],
    );
    const again = await resort(
      t,
      -10,
      "The breaker is tripping again. Not happy.",
      classification({ category: "complaint", summary: "Breaker trips again." }),
    );
    expect(again.category).toBe("complaint");
    expect(again.complainedAt).toEqual(at(-10));
    const fine = await resort(t, -1 / 24, "Fixed now, looks great. Thanks!", happy());
    expect(fine.category).toBe("customer_question");
    expect(fine.complainedAt).toEqual(at(-10));

    const other = await jobDone();
    const calls = model(reviewBody);
    expect(await askReview(other)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
  });

  it("a customer who complained on another job in the last 12 months isn't asked either", async () => {
    await profile();
    const earlier = await jobDone({ category: "customer_question", complainedAt: at(-200) });
    const t = await jobDone();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
    // Case doesn't matter.
    const shouty = await jobDone({}, "DANA@Customer.com");
    expect(await reviewAllowed(workspaceId, shouty, NOW)).toBe("complaint");
    // A complaint over a year ago no longer counts.
    await database
      .update(threads)
      .set({ complainedAt: at(-400) })
      .where(eq(threads.id, earlier));
    expect(await reviewAllowed(workspaceId, t, NOW)).toBeNull();
  });

  const owed42 = {
    invoice: { invoice_number: "42", amount: 1200, due_date: null, status: "unpaid" as const },
    invoice_thread: true,
  };
  /** Invoice #42 for $1,200 went out; Dana owes it. Sorted. */
  async function invoiceOwed() {
    const t = await makeThread(
      {
        category: "invoice_payment",
        extracted: owed42,
        summary: "Invoice 42.",
        classifiedAt: at(-8),
      },
      [
        { direction: "in", days: -9, body: "Can you send the bill?" },
        { direction: "out", days: -8, body: "Invoice 42 attached: $1,200. Davi" },
      ],
    );
    await database
      .update(messages)
      .set({ classifiedAt: at(-9) })
      .where(eq(messages.threadId, t));
    return t;
  }
  const paidBalance = () =>
    classification({
      category: "invoice_payment",
      summary: "Dana paid the balance.",
      extracted: {
        ...classification().extracted,
        service_requested: null,
        invoice: { invoice_number: "42", amount: null, due_date: null, status: "paid" },
      },
    });
  async function ownerSortsItOut(t: string) {
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `${t}-sorted`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [DANA],
      subject: "Invoice",
      bodyText: "Sorry Dana — we'll finish the trim Monday. Davi",
      sentAt: at(-5),
    });
    // Sending the reply clears needs-owner (sendDraft does this).
    await database.update(threads).set({ needsOwner: false }).where(eq(threads.id, t));
  }

  it("GUARDRAIL: a disputed charge is a complaint — paid later, still no review, no model call", async () => {
    await profile();
    const t = await invoiceOwed();
    // "I'm disputing this charge, the work wasn't finished." Sorted invoice_payment (the
    // prompt's own rule for amount disputes) with the model's own reason, not ours.
    const disputed = await resort(
      t,
      -6,
      "I'm disputing this charge, the work wasn't finished.",
      classification({
        category: "invoice_payment",
        needs_owner: true,
        needs_owner_reason: "Dana disputes invoice 42.",
        summary: "Dana disputes the invoice.",
        signals: { ...classification().signals, mentions_refund_or_dispute: true },
        extracted: { ...classification().extracted, invoice: owed42.invoice },
      }),
    );
    expect(disputed).toMatchObject({ category: "invoice_payment", needsOwner: true });
    expect(disputed.extracted).toMatchObject({ disputed: true });
    expect(disputed.complainedAt).toEqual(at(-6));

    await ownerSortsItOut(t);
    // "OK, paid the balance." → our paid guess, needs-owner off: everything else says yes.
    const paid = await resort(t, -1 / 24, "OK, paid the balance.", paidBalance());
    expect(paid).toMatchObject({ needsOwner: false, invoicePaidSource: "auto" });
    expect(paid.extracted).not.toHaveProperty("disputed");
    expect(paid.complainedAt).toEqual(at(-6));

    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
    // Nor on their other jobs for 12 months.
    const other = await jobDone();
    expect(await reviewAllowed(workspaceId, other, NOW)).toBe("complaint");
  });

  it("…a legal threat too", async () => {
    await profile();
    const t = await invoiceOwed();
    const legal = await resort(
      t,
      -6,
      "If this isn't fixed I'll file a lien.",
      classification({
        category: "invoice_payment",
        summary: "Dana threatens a lien.",
        signals: { ...classification().signals, mentions_legal: true },
        extracted: { ...classification().extracted, invoice: owed42.invoice },
      }),
    );
    expect(legal.complainedAt).toEqual(at(-6));
    await ownerSortsItOut(t);
    await resort(t, -1 / 24, "OK, paid the balance.", paidBalance());
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "complaint" });
    expect(calls).toHaveLength(0);
  });

  it("a dispute sorted before `disputed` existed (only its reason shows) still blocks", async () => {
    await profile();
    // Older code: needs-owner with our dispute reason, no mark, no flag.
    const t = await jobDone({
      category: "invoice_payment",
      needsOwner: false,
      needsOwnerReason: "Asks for money back or disputes a charge.",
      extracted: { job_done: true },
      complainedAt: null,
    });
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("complaint");
    const other = await jobDone();
    expect(await reviewAllowed(workspaceId, other, NOW)).toBe("complaint");
    // A quote whose customer disputed something isn't asked "did you go another way?" either.
    process.env.FEATURE_CLOSING_QUESTION = "on";
    // (The legal reason's older wording, Check 10 P10: stored rows keep it and still count.)
    const quiet = await quietQuote({ needsOwnerReason: "Mentions something legal." });
    expect(await closingQuestionAllowed(workspaceId, quiet, NOW)).toBe("complaint");
    // The next email gives it the sticky mark.
    await database.update(messages).set({ classifiedAt: at(-1) });
    const later = await resort(t, -1 / 48, "Thanks again!", happy());
    expect(later.complainedAt).not.toBeNull();
    expect(await reviewAllowed(workspaceId, other, NOW)).toBe("complaint");
  });
});

describe("a deposit is not the job being paid (#29)", () => {
  it("GUARDRAIL: 'Let's do it, sent the $500 deposit' on a quote → no paid mark, no review offer", async () => {
    await profile();
    const t = await makeThread(
      {
        category: "quote_request",
        extracted: {},
        summary: "Dana wants a panel.",
        classifiedAt: at(-5),
      },
      [
        { direction: "in", days: -6, body: "How much for a 200 amp panel?" },
        { direction: "out", days: -5, body: "It's $2,400 including the permit. Davi" },
      ],
    );
    await database
      .update(messages)
      .set({ classifiedAt: at(-6) })
      .where(eq(messages.threadId, t));
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `${t}-deposit`,
      direction: "in",
      fromAddress: DANA,
      toAddresses: ["owner@shop.com"],
      subject: "Panel",
      bodyText: "Let's do it, just sent the $500 deposit by Zelle.",
      labelIds: ["INBOX"],
      sentAt: at(-1),
    });
    setModelTransportForTests(
      fakeTransport([
        classification({
          category: "invoice_payment",
          summary: "Dana accepts and sent the deposit.",
          signals: { ...classification().signals, accepts_quote: true },
          extracted: {
            ...classification().extracted,
            invoice: { invoice_number: null, amount: 500, due_date: null, status: "paid" },
          },
        }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: at(-1) });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toMatchObject({
      invoicePaidAt: null,
      invoicePaidSource: null,
      quoteOutcome: "won",
    });
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("not_eligible");
    const money = await listMoney(workspaceId, NOW);
    expect(money.paidRecently).toEqual([]);
    expect(money.owed).toEqual([]);
  });
});

describe("GUARDRAIL: only real customers (A2)", () => {
  it("a Stripe receipt thread is never review-eligible and never an owed or paid row", async () => {
    await profile();
    const receipt = await jobDone(
      {
        category: "invoice_payment",
        extracted: {
          job_done: true,
          invoice: { invoice_number: "41", amount: 199, status: "paid" },
          invoice_thread: true,
        },
        invoicePaidAt: at(-1),
        invoicePaidSource: "auto",
      },
      "receipts@stripe.com",
    );
    expect((await threadOffers(workspaceId, [receipt], NOW)).get(receipt)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(receipt)).toEqual({ status: "skipped", reason: "not_eligible" });
    expect(calls).toHaveLength(0);
    const money = await listMoney(workspaceId, NOW);
    for (const list of [money.owed, money.paidRecently, money.hidden]) {
      expect(list.map((r) => r.threadId)).not.toContain(receipt);
    }
  });

  it("no-reply senders, suppliers and people the owner never wrote to: not eligible", async () => {
    await profile();
    const noreply = await jobDone({}, "no-reply@builder.test");
    const supplier = await jobDone({ category: "supplier_vendor" }, "orders@supply.test");
    const stranger = await makeThread({}, [
      { direction: "in", days: -1, body: "Great job on the panel!", from: "stranger@x.test" },
    ]);
    const offers = await threadOffers(workspaceId, [noreply, supplier, stranger], NOW);
    for (const t of [noreply, supplier, stranger]) {
      expect(offers.get(t)?.review).toBe(false);
      expect(await reviewAllowed(workspaceId, t, NOW)).toBe("not_eligible");
    }
  });
});

describe("GUARDRAIL: one review request per customer address per 12 months", () => {
  it("a sent one 200 days ago on another thread blocks; case doesn't matter", async () => {
    await profile();
    await reviewOnFile("sent", -200, "Dana@Customer.com");
    const t = await jobDone();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "review_recent" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("a waiting one blocks; edited-and-sent blocks", async () => {
    await profile();
    await reviewOnFile("pending", -2);
    const t = await jobDone();
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("review_recent");
    await database.update(drafts).set({ status: "edited_and_sent" });
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("review_recent");
  });

  it("the 12 months count from when it was sent: drafted 370 days ago, sent 340 days ago, blocks", async () => {
    await profile();
    await reviewOnFile("sent", -370, DANA, -340);
    const t = await jobDone();
    expect(await reviewAllowed(workspaceId, t, NOW)).toBe("review_recent");
    const calls = model(reviewBody);
    expect(await askReview(t)).toEqual({ status: "skipped", reason: "review_recent" });
    expect(calls).toHaveLength(0);
  });

  it("a discarded or expired one doesn't; one 366 days ago doesn't", async () => {
    await profile();
    await reviewOnFile("discarded", -10);
    await reviewOnFile("expired", -10);
    await reviewOnFile("sent", -366);
    const t = await jobDone();
    expect(await reviewAllowed(workspaceId, t, NOW)).toBeNull();
    model(reviewBody);
    expect((await askReview(t)).status).toBe("created");
  });

  it("two taps at once on two jobs for the same customer: exactly one is drafted (A16)", async () => {
    await profile();
    const a = await jobDone();
    const b = await jobDone({}, "DANA@customer.com");
    model(reviewBody, reviewBody);
    const results = await Promise.all([askReview(a), askReview(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(["created", "skipped"]);
    expect(results.find((r) => r.status === "skipped")).toEqual({
      status: "skipped",
      reason: "review_recent",
    });
    const rows = await database.select().from(drafts).where(eq(drafts.purpose, "review_request"));
    expect(rows).toHaveLength(1);
    // No orphan left in Gmail.
    expect(writer.drafts.size).toBe(1);
  });

  it("the create path holds the per-address lock, in its transaction, before the insert", async () => {
    await profile();
    const t = await jobDone({}, "Dana@Customer.com");
    const { lockReviewAddress: realLock } =
      await vi.importActual<typeof import("@/server/review-lock")>("@/server/review-lock");
    const seen: { held: number; rowsBefore: number }[] = [];
    vi.mocked(lockReviewAddress).mockImplementationOnce(async (tx, ws, address) => {
      await realLock(tx, ws, address);
      const q = tx as unknown as Database;
      // Still held after the statement → taken inside a transaction, not in autocommit.
      const locks = (await q.execute(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`,
      )) as unknown as { rows?: { n: number }[] } & { n: number }[];
      const held = Number((locks.rows ?? locks)[0]!.n);
      // And before the draft row exists.
      const before = await q.select({ id: drafts.id }).from(drafts).where(eq(drafts.threadId, t));
      seen.push({ held, rowsBefore: before.length });
    });
    model(reviewBody);
    expect((await askReview(t)).status).toBe("created");
    expect(lockReviewAddress).toHaveBeenCalledTimes(1);
    // The reply address, normalized (lowercased) like every stored address.
    expect(lockReviewAddress).toHaveBeenCalledWith(
      expect.anything(),
      workspaceId,
      "dana@customer.com",
    );
    expect(seen).toEqual([{ held: 1, rowsBefore: 0 }]);
  });

  it("the lock decides even when both got past the first check", async () => {
    await profile();
    const a = await jobDone();
    const b = await jobDone();
    // While A's model call runs, B's request lands (as if both passed the first check).
    const { transport } = fakeTransport([reply(reviewBody)]);
    let once = false;
    const racing: Transport = async (req) => {
      if (!once) {
        once = true;
        await database.insert(drafts).values({
          threadId: b,
          mailboxId,
          kind: "reply",
          purpose: "review_request",
          status: "pending",
          toAddress: DANA,
          subject: "Re: Panel upgrade",
          body: `A review? ${REVIEW_URL}`,
          reason: "Review request.",
          createdAt: NOW,
        });
      }
      return transport(req);
    };
    setModelTransportForTests(racing);
    expect(await askReview(a)).toEqual({ status: "skipped", reason: "review_recent" });
    expect(writer.calls).toEqual(["createDraft", "deleteDraft"]);
    expect(writer.drafts.size).toBe(0);
  });
});

describe("GUARDRAIL: closing question never created by a job", () => {
  it("auto and followup triggers are refused before the model; the scan never makes one", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    expect(await closingQuestionAllowed(workspaceId, t, NOW)).toBeNull();
    const calls = model(closingBody, closingBody, closingBody);
    for (const trigger of ["auto", "followup"] as const) {
      expect(
        await createDraftForThread(t, {
          trigger,
          purpose: "closing_question",
          ...deps(),
        } as never),
      ).toEqual({ status: "skipped", reason: "purpose_not_allowed" });
    }
    expect(calls).toHaveLength(0);

    // The daily scan's own path: both nudges used, so it never picks the thread, and even
    // forced through, the drafter makes a nudge-cap skip — never a closing question.
    expect(await threadsToFollowUp(mailboxId, NOW)).not.toContain(t);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_cap",
    });
    expect(
      await database.select().from(drafts).where(eq(drafts.purpose, "closing_question")),
    ).toEqual([]);
    expect(writer.calls).toEqual([]);
  });

  it("no job passes a purpose (static check of src/jobs/functions.ts)", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    expect(src).not.toContain("closing_question");
    expect(src).not.toContain("purpose");
  });
});

describe("closing question: an unsent Gmail draft isn't the owner writing", () => {
  it("a draft stored by old sync two days ago doesn't restart the 7 quiet days", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `${t}-unsent`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [DANA],
      labelIds: ["DRAFT"],
      bodyText: "Draft never sent.",
      sentAt: at(-2),
    });
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.closingQuestion).toBe(true);
  });
});

describe("GUARDRAIL: closing question never twice", () => {
  it("asked once (own activity, not a nudge); after a discard, a second tap is refused", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)).toEqual({
      review: false,
      closingQuestion: true,
      thankYou: false,
    });
    const calls = model(closingBody, closingBody);
    const r = await askClosing(t);
    expect(r).toEqual({ status: "created", draftId: expect.any(String) });
    expect(calls[0]!.user).toContain("## Task: closing question");
    const id = (r as { draftId: string }).draftId;
    expect(await draftRow(id)).toMatchObject({ purpose: "closing_question", kind: "reply" });
    const logs = await database
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.workspaceId, workspaceId), eq(activityLog.threadId, t)));
    expect(logs.map((l) => l.action)).toEqual(["closing_question"]);
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(2);

    expect(await discardDraft(workspaceId, id, deps())).toBe("discarded");
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.closingQuestion).toBe(false);
    expect(await askClosing(t)).toEqual({ status: "skipped", reason: "already_asked" });
    expect(calls).toHaveLength(1);

    // And the database itself refuses a second one for the thread, whatever its status.
    await expect(
      database.insert(drafts).values({
        threadId: t,
        mailboxId,
        kind: "reply",
        purpose: "closing_question",
        status: "discarded",
        toAddress: DANA,
        subject: "Re: Panel upgrade",
        body: "Again?",
        reason: "x",
      }),
    ).rejects.toThrow();
  });

  it("a race on the unique index reads 'already asked', not 'a draft is waiting' (A7)", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    const { transport } = fakeTransport([reply(closingBody)]);
    // Another tap's closing question lands while this one is being written.
    setModelTransportForTests(async (req) => {
      await database.insert(drafts).values({
        threadId: t,
        mailboxId,
        kind: "reply",
        purpose: "closing_question",
        status: "discarded",
        toAddress: DANA,
        subject: "Re: Panel upgrade",
        body: "Did you go another way?",
        reason: "x",
      });
      return transport(req);
    });
    expect(await askClosing(t)).toEqual({ status: "skipped", reason: "already_asked" });
    expect(writer.calls).toEqual(["createDraft", "deleteDraft"]);
    expect(writer.drafts.size).toBe(0);
  });

  it("a race with an ordinary waiting reply still reads 'already pending' (A7)", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    const { transport } = fakeTransport([reply(closingBody)]);
    setModelTransportForTests(async (req) => {
      await database.insert(drafts).values({
        threadId: t,
        mailboxId,
        kind: "reply",
        status: "pending",
        toAddress: DANA,
        subject: "Re: Panel upgrade",
        body: "Hi Dana",
        reason: "x",
      });
      return transport(req);
    });
    expect(await askClosing(t)).toEqual({ status: "skipped", reason: "already_pending" });
    expect(writer.drafts.size).toBe(0);
    expect(
      await database.select().from(drafts).where(eq(drafts.purpose, "closing_question")),
    ).toEqual([]);
  });

  it("not before a quiet week, not with one nudge, not after the customer replied", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const early = await quietQuote({}, -6);
    expect(await closingQuestionAllowed(workspaceId, early, NOW)).toBe("not_eligible");
    const oneNudge = await quietQuote();
    await database
      .delete(drafts)
      .where(and(eq(drafts.threadId, oneNudge), eq(drafts.createdAt, at(-18))));
    expect(await closingQuestionAllowed(workspaceId, oneNudge, NOW)).toBe("not_eligible");
    const won = await quietQuote({ quoteOutcome: "won", quoteOutcomeSource: "owner" });
    expect(await closingQuestionAllowed(workspaceId, won, NOW)).toBe("not_eligible");
    const replied = await quietQuote();
    await database.insert(messages).values({
      threadId: replied,
      mailboxId,
      gmailMessageId: `${replied}-late`,
      direction: "in",
      fromAddress: DANA,
      subject: "Panel upgrade",
      bodyText: "Sorry, been busy!",
      sentAt: at(-1),
    });
    expect(await closingQuestionAllowed(workspaceId, replied, NOW)).toBe("not_eligible");
    const calls = model(closingBody);
    for (const t of [early, oneNudge, won, replied]) {
      expect(await askClosing(t)).toEqual({ status: "skipped", reason: "not_eligible" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("closing question: not offered when the tap can only fail", () => {
  it("a draft waiting on the thread, or the owner's last message purged", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const waiting = await quietQuote();
    await database.insert(drafts).values({
      threadId: waiting,
      mailboxId,
      kind: "reply",
      status: "pending",
      toAddress: DANA,
      subject: "Re: Panel upgrade",
      body: "A note.",
      reason: "Owner asked.",
      createdAt: NOW,
    });
    const purged = await quietQuote();
    await database
      .update(messages)
      .set({ bodyText: null, snippet: null })
      .where(eq(messages.threadId, purged));
    const ok = await quietQuote();
    const offers = await threadOffers(workspaceId, [waiting, purged, ok], NOW);
    expect(offers.get(waiting)?.closingQuestion).toBe(false);
    expect(offers.get(purged)?.closingQuestion).toBe(false);
    expect(offers.get(ok)?.closingQuestion).toBe(true);
  });
});

describe("GUARDRAIL: closing question off by default", () => {
  it("env unset → never offered, and a tap is refused before the model", async () => {
    await profile();
    const t = await quietQuote();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.closingQuestion).toBe(false);
    const calls = model(closingBody);
    expect(await askClosing(t)).toEqual({ status: "skipped", reason: "feature_off" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });
});

describe("closing question does not count as a nudge", () => {
  it("after it's sent: still 2 nudges, followup_count 2, and no 'I'll nudge' / 'last nudge'", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const t = await quietQuote();
    model(closingBody);
    const r = await askClosing(t);
    const id = (r as { draftId: string }).draftId;
    expect(await sendDraft(workspaceId, id, deps())).toMatchObject({ status: "sent" });
    expect(await countSentFollowups(t)).toBe(2);
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(2);
    expect(await sentDraftSummary(workspaceId, id)).toMatchObject({
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });
});

describe("GUARDRAIL: read-only and other workspaces", () => {
  it("evaluation_expired → no offers at all, and every tap is read_only with no model call", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const job = await jobDone();
    const quote = await quietQuote();
    await setStatus("evaluation_expired");
    expect((await threadOffers(workspaceId, [job, quote], NOW)).size).toBe(0);
    const calls = model(reviewBody, closingBody);
    expect(await askReview(job)).toEqual({ status: "skipped", reason: "read_only" });
    expect(await askClosing(quote)).toEqual({ status: "skipped", reason: "read_only" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("another workspace's owner gets not_found, and sees no offers for the thread", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile();
    const job = await jobDone();
    const quote = await quietQuote();
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.id));
    expect((await threadOffers(other.id, [job, quote], NOW)).size).toBe(0);
    expect(await reviewAllowed(other.id, job, NOW)).toBe("not_found");
    const calls = model(reviewBody, closingBody);
    expect(await askReview(job, NOW, other.id)).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(
      await createDraftForThread(quote, {
        trigger: "owner",
        workspaceId: other.id,
        purpose: "closing_question",
        ...deps(),
      }),
    ).toEqual({ status: "skipped", reason: "not_found" });
    expect(calls).toHaveLength(0);
  });
});
