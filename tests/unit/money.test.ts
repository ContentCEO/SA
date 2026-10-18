import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { MailboxAuthError } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity, listActivity } from "@/server/activity";
import { classifyPending } from "@/server/classification";
import { buildDigest, digestCounts } from "@/server/digest";
import { queueThreadUrl } from "@/server/digest-rules";
import {
  createDraftForThread,
  expirePendingNudge,
  queueSend,
  sentDraftSummary,
} from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { autoMarkInvoicePaid, listMoney, setInvoiceNotOwed, setInvoicePaid } from "@/server/money";
import {
  billOwedByOwner,
  carryInvoiceFacts,
  clearsAutoPaid,
  dueLabel,
  holdsOwedInvoice,
  invoiceOf,
  isNewInvoice,
  isOwed,
  isReceiptSender,
  matchReceipt,
  normalizeInvoiceNumber,
  PAID_GUESS_FLAG,
  PAID_NOTE,
  paymentSaid,
  promoteEarlierOpen,
  sortOwed,
  type InvoiceFacts,
} from "@/server/money-rules";
import { pushSummaryText } from "@/server/push-alerts";
import { leadAlertBody } from "@/server/sms-alerts";
import {
  billOwedByOwnerSql,
  senderHasSupplierThreadSql,
  senderMarkedNotOwedSql,
} from "@/server/thread-sql";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const inv = (o: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  invoice_number: null,
  amount: 1200,
  due_date: null,
  status: "unpaid",
  ...o,
});

describe("money rules", () => {
  it("reads the due date from the owner's own calendar day", () => {
    const tz = "America/New_York";
    expect(dueLabel(null, NOW, tz)).toEqual({ daysPastDue: null, text: "No due date" });
    // Never a guess: words that aren't a date are no due date.
    for (const vague of ["net 30", "upon receipt", "end of month", "Friday", "2026", "Feb 31"]) {
      expect(dueLabel(vague, NOW, tz)).toEqual({ daysPastDue: null, text: "No due date" });
    }
    expect(dueLabel("2026-10-20", NOW, tz)).toEqual({ daysPastDue: -10, text: "Not due yet" });
    expect(dueLabel("2026-10-10", NOW, tz)).toEqual({ daysPastDue: 0, text: "Due today" });
    expect(dueLabel("2026-10-07", NOW, tz)).toEqual({ daysPastDue: 3, text: "3 days past due" });
    expect(dueLabel("2026-10-09", NOW, tz).text).toBe("1 day past due");
    // Written out, with and without a year (no year = this year, not 2001).
    expect(dueLabel("October 7, 2026", NOW, tz).text).toBe("3 days past due");
    expect(dueLabel("Oct 7", NOW, tz).text).toBe("3 days past due");
    expect(dueLabel("due by October 7th", NOW, tz).text).toBe("3 days past due");
    expect(dueLabel("7 Oct 2026", NOW, tz).text).toBe("3 days past due");
    expect(dueLabel("10/7/2026", NOW, tz).text).toBe("3 days past due");
    expect(dueLabel("11/3", NOW, tz).text).toBe("Not due yet");
    // Time-zone boundary: 1am UTC on the 11th is still the 10th in New York.
    const lateEvening = new Date("2026-10-11T01:00:00Z");
    expect(dueLabel("2026-10-10", lateEvening, tz).text).toBe("Due today");
    expect(dueLabel("2026-10-10", lateEvening, "UTC").text).toBe("1 day past due");
    // A bad time zone falls back to Eastern rather than throwing.
    expect(dueLabel("2026-10-10", lateEvening, "Not/AZone").text).toBe("Due today");
  });

  it("puts a date with no year in the year that makes sense around New Year", () => {
    const tz = "America/New_York";
    // Seen in late December, "Jan 5" is next month — not 349 days late.
    const dec20 = new Date("2026-12-20T15:00:00Z");
    expect(dueLabel("Jan 5", dec20, tz)).toEqual({ daysPastDue: -16, text: "Not due yet" });
    expect(dueLabel("1/5", dec20, tz).text).toBe("Not due yet");
    expect(dueLabel("Dec 18", dec20, tz).text).toBe("2 days past due");
    // Seen early January, "Dec 28" was last month — 6 days late, not next December.
    const jan3 = new Date("2027-01-03T15:00:00Z");
    expect(dueLabel("Dec 28", jan3, tz)).toEqual({ daysPastDue: 6, text: "6 days past due" });
    expect(dueLabel("12/28", jan3, tz).text).toBe("6 days past due");
    expect(dueLabel("Jan 10", jan3, tz).text).toBe("Not due yet");
    // A long-overdue one stays in the past; a year that's written is always taken as written.
    expect(dueLabel("Mar 1", NOW, tz).text).toBe("223 days past due");
    expect(dueLabel("Jan 5, 2026", dec20, tz).text).toBe("349 days past due");
  });

  it("reads a date with no year around when the email was written, not today", () => {
    const tz = "America/New_York";
    // Invoiced Nov 2025, "due Dec 5", still unpaid in Oct 2026: about ten months late —
    // not "Not due yet" for this coming December.
    const written = new Date("2025-11-10T15:00:00Z");
    expect(dueLabel("Dec 5", NOW, tz, written)).toEqual({
      daysPastDue: 309,
      text: "309 days past due",
    });
    expect(dueLabel("12/5", NOW, tz, written).text).toBe("309 days past due");
    // Without the email's date it falls back to today (and a future date is ignored).
    expect(dueLabel("Dec 5", NOW, tz).text).toBe("Not due yet");
    expect(dueLabel("Dec 5", NOW, tz, new Date("2027-01-01T00:00:00Z")).text).toBe("Not due yet");
    // A recent email reads the same either way; a written year is always taken as written.
    expect(dueLabel("Oct 7", NOW, tz, daysAgo(4)).text).toBe("3 days past due");
    expect(dueLabel("Dec 5, 2026", NOW, tz, written).text).toBe("Not due yet");
  });

  it("knows what's owed — and the owner's undo beats the email", () => {
    const o = (
      invoice: InvoiceFacts | null,
      paidAt: Date | null = null,
      paidSource: string | null = null,
    ) => isOwed({ invoice, paidAt, paidSource });
    expect(o(inv())).toBe(true);
    expect(o(inv({ status: "partly_paid" }))).toBe(true);
    expect(o(inv({ status: "paid" }))).toBe(false);
    expect(o(inv({ status: "unknown" }))).toBe(false);
    expect(o(inv({ status: "paid" }), null, "owner")).toBe(true); // the owner undid a paid mark
    // Check 12 P5: an unpaid invoice with no amount is owed too ("Amount not stated").
    expect(o(inv({ amount: null }))).toBe(true);
    // The owner put back a row whose email never said how much: it's owed, amount unknown.
    expect(o(inv({ amount: null }), null, "owner")).toBe(true);
    expect(o(null, null, "owner")).toBe(true);
    expect(o(inv(), NOW, "owner")).toBe(false);
    expect(o(inv(), NOW, "auto")).toBe(false);
    expect(o(inv(), NOW, "not_owed")).toBe(false);
    expect(o(null)).toBe(false);
  });

  it("reads invoice facts loosely, so old or odd rows never throw", () => {
    expect(invoiceOf(null)).toBeNull();
    expect(invoiceOf({ invoice: null })).toBeNull();
    expect(invoiceOf({ invoice: "x" })).toBeNull();
    expect(invoiceOf({ invoice: { amount: "12", status: "weird", invoice_number: " " } })).toEqual({
      invoice_number: null,
      amount: null,
      due_date: null,
      status: "unknown",
    });
    expect(invoiceOf({ invoice: inv({ invoice_number: "INV-7" }) })).toEqual(
      inv({ invoice_number: "INV-7" }),
    );
  });

  it("sorts the oldest due first, then no due date by the oldest conversation", () => {
    const row = (id: string, daysPastDue: number | null, lastAgo: number) => ({
      id,
      due: { daysPastDue },
      lastMessageAt: daysAgo(lastAgo),
    });
    const sorted = sortOwed([
      row("none-new", null, 1),
      row("soon", -5, 2),
      row("late3", 3, 4),
      row("none-old", null, 9),
      row("late12", 12, 3),
      row("today", 0, 2),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      "late12",
      "late3",
      "today",
      "soon",
      "none-old",
      "none-new",
    ]);
  });

  it("one invoice number, however it's written", () => {
    expect(normalizeInvoiceNumber("INV-0042")).toBe(normalizeInvoiceNumber("#42"));
    expect(normalizeInvoiceNumber("Invoice No. 42")).toBe("42");
    expect(normalizeInvoiceNumber("inv 42")).toBe("42");
    expect(normalizeInvoiceNumber("A-1009")).toBe("a1009");
    expect(normalizeInvoiceNumber("#")).toBeNull();
    expect(normalizeInvoiceNumber(null)).toBeNull();
  });

  it("matches a receipt by invoice number only — never by amount alone (A12)", () => {
    const open = [
      { threadId: "a", invoice: inv({ invoice_number: "INV-0042", amount: 199 }) },
      { threadId: "b", invoice: inv({ invoice_number: "1043", amount: 199 }) },
      { threadId: "c", invoice: inv({ amount: 500 }) },
    ];
    expect(matchReceipt(inv({ invoice_number: "#42", amount: 199, status: "paid" }), open)).toBe(
      "a",
    );
    // A receipt that doesn't say how much matches on the number alone.
    expect(
      matchReceipt(inv({ invoice_number: "Invoice 1043", amount: null, status: "paid" }), open),
    ).toBe("b");
    // A unique amount with no number is still no match: it could be the owner's own purchase.
    expect(matchReceipt(inv({ amount: 500, status: "paid" }), open)).toBeNull();
    expect(matchReceipt(inv({ amount: 199, status: "paid" }), open)).toBeNull();
    expect(
      matchReceipt(inv({ invoice_number: "9999", amount: null, status: "paid" }), open),
    ).toBeNull();
    // Two open invoices with the same number → we can't tell.
    const twice = [...open, { threadId: "d", invoice: inv({ invoice_number: "42", amount: 199 }) }];
    expect(
      matchReceipt(inv({ invoice_number: "42", amount: 199, status: "paid" }), twice),
    ).toBeNull();
    // Same number, different amount → someone else's invoice 1043 (QuickBooks starts at 1001).
    expect(
      matchReceipt(inv({ invoice_number: "1043", amount: 845.5, status: "paid" }), open),
    ).toBeNull();
    expect(
      matchReceipt(inv({ invoice_number: "1043", amount: 199.004, status: "paid" }), open),
    ).toBe("b");
  });

  it("knows a different invoice number, still to be paid, is a new invoice", () => {
    const paid41 = inv({ invoice_number: "#41", status: "paid" });
    expect(isNewInvoice(paid41, inv({ invoice_number: "INV-42" }))).toBe(true);
    expect(isNewInvoice(paid41, inv({ invoice_number: "42", status: "partly_paid" }))).toBe(true);
    expect(isNewInvoice(paid41, inv({ invoice_number: "INV-0041" }))).toBe(false);
    expect(isNewInvoice(paid41, inv({ invoice_number: "42", status: "paid" }))).toBe(false);
    expect(isNewInvoice(paid41, inv({ invoice_number: "42", status: "unknown" }))).toBe(false);
    expect(isNewInvoice(paid41, inv())).toBe(false);
    expect(isNewInvoice(inv(), inv({ invoice_number: "42" }))).toBe(false);
    expect(isNewInvoice(null, inv({ invoice_number: "42" }))).toBe(false);
  });

  it("knows receipt senders, subdomains included, and isn't fooled by look-alikes", () => {
    expect(isReceiptSender("receipts@stripe.com")).toBe(true);
    expect(isReceiptSender("no-reply@notification.intuit.com")).toBe(true);
    expect(isReceiptSender("QuickBooks <Payments@QuickBooks.com>")).toBe(true);
    expect(isReceiptSender("x@stripe.com.evil.test")).toBe(false);
    expect(isReceiptSender("x@notstripe.com")).toBe(false);
    expect(isReceiptSender("stripe.com")).toBe(false);
    expect(isReceiptSender(null)).toBe(false);
  });

  it("carries the earlier invoice over, so 'paid, thanks' keeps the amount (A11)", () => {
    const prev = inv({ invoice_number: "42", amount: 1200, due_date: "2026-10-01" });
    expect(carryInvoiceFacts(prev, inv({ amount: null, status: "paid" }))).toEqual({
      invoice_number: "42",
      amount: 1200,
      due_date: "2026-10-01",
      status: "paid",
    });
    expect(carryInvoiceFacts(prev, null)).toEqual(prev);
    expect(carryInvoiceFacts(null, null)).toBeNull();
    expect(carryInvoiceFacts(null, inv())).toEqual(inv());
    // Same invoice, the email doesn't say paid or not: the earlier word stands.
    expect(
      carryInvoiceFacts(prev, inv({ invoice_number: "INV-42", amount: null, status: "unknown" })),
    ).toMatchObject({ amount: 1200, status: "unpaid" });
    // A different number is a different invoice — and the earlier one, still owed, is kept
    // beside it rather than silently dropped (a deposit invoice, then the final one).
    const other = inv({ invoice_number: "43", amount: 300 });
    const both = carryInvoiceFacts(prev, other);
    expect(both).toEqual({
      ...other,
      earlier_open: [{ invoice_number: "42", amount: 1200 }],
    });
    expect(invoiceOf({ invoice: both })).toEqual(both);
    // …unless the earlier one wasn't owed any more (marked paid, or hidden as not owed).
    expect(carryInvoiceFacts(prev, other, false)).toEqual(other);
    expect(carryInvoiceFacts(inv({ ...prev, status: "paid" }), other)).toEqual(other);
    // The same invoice again keeps the earlier ones; "paid #42" settles just that one.
    expect(carryInvoiceFacts(both, inv({ invoice_number: "43", amount: null }))).toEqual(both);
    expect(
      carryInvoiceFacts(both, inv({ invoice_number: "INV-42", amount: null, status: "paid" })),
    ).toEqual(other);
  });

  it("paying the current invoice while an earlier one is open promotes the earlier one", () => {
    // #42 $2,000 is current, #41 $500 still open. "Paid invoice 42" settles #42 only.
    const cur = inv({
      invoice_number: "42",
      amount: 2000,
      earlier_open: [
        { invoice_number: "41", amount: 500 },
        { invoice_number: "40", amount: 250 },
      ],
    });
    expect(
      carryInvoiceFacts(cur, inv({ invoice_number: "42", amount: null, status: "paid" })),
    ).toEqual({
      invoice_number: "41",
      amount: 500,
      due_date: null,
      status: "unpaid",
      earlier_open: [{ invoice_number: "40", amount: 250 }],
    });
    // "Paid, thanks" with no number is the current one too.
    expect(carryInvoiceFacts(cur, inv({ amount: null, status: "paid" }))).toMatchObject({
      invoice_number: "41",
      status: "unpaid",
    });
    // Nothing left open: paid is paid.
    expect(promoteEarlierOpen(inv({ status: "paid" }))).toEqual(inv({ status: "paid" }));
    expect(promoteEarlierOpen(null)).toBeNull();
    // Not paid: unchanged.
    expect(promoteEarlierOpen(cur)).toEqual(cur);
  });

  it("an earlier open invoice is owed even when the current one has no amount", () => {
    // #41 $500 unpaid, then "Got invoice #42 for phase 2" (no amount).
    const carried = carryInvoiceFacts(
      inv({ invoice_number: "41", amount: 500 }),
      inv({ invoice_number: "42", amount: null }),
    );
    expect(carried).toMatchObject({ amount: null, earlier_open: [{ amount: 500 }] });
    expect(holdsOwedInvoice(carried)).toBe(true);
    expect(isOwed({ invoice: carried, paidAt: null, paidSource: null })).toBe(true);
    expect(isOwed({ invoice: carried, paidAt: NOW, paidSource: "auto" })).toBe(false);
    // Check 12 P5: an unpaid invoice with no amount is owed ("Amount not stated").
    expect(holdsOwedInvoice(inv({ amount: null }))).toBe(true);
    expect(holdsOwedInvoice(inv({ status: "paid" }))).toBe(false);
    expect(holdsOwedInvoice(null)).toBe(false);
  });

  it("our paid guess is cleared by a new amount owed — never by the same invoice again", () => {
    const deposit = inv({ amount: 900, status: "paid" });
    // A deposit with no number, then "Got invoice #1043 for $3,000": owed again.
    expect(clearsAutoPaid(deposit, inv({ invoice_number: "1043", amount: 3000 }))).toBe(true);
    // A new number.
    const paid42 = inv({ invoice_number: "42", amount: 2000, status: "paid" });
    expect(clearsAutoPaid(paid42, inv({ invoice_number: "43", amount: 300 }))).toBe(true);
    // The same number, a different amount ("I paid $1,000 of 42, rest next week").
    expect(
      clearsAutoPaid(paid42, inv({ invoice_number: "42", amount: 1000, status: "partly_paid" })),
    ).toBe(true);
    // The same invoice, the same amount, or no amount: the guess stands.
    expect(clearsAutoPaid(paid42, inv({ invoice_number: "INV-42", amount: 2000 }))).toBe(false);
    expect(clearsAutoPaid(paid42, inv({ invoice_number: "43", amount: null }))).toBe(false);
    expect(clearsAutoPaid(paid42, inv({ invoice_number: "43", status: "paid" }))).toBe(false);
    expect(clearsAutoPaid(paid42, inv({ invoice_number: "43", status: "unknown" }))).toBe(false);
    expect(clearsAutoPaid(paid42, null)).toBe(false);
  });

  it("reads what the newest email said about paying, and nothing else", () => {
    expect(paymentSaid({ payment_said: "paid" })).toBe("paid");
    expect(paymentSaid({ payment_said: "partly_paid" })).toBe("partly_paid");
    expect(paymentSaid({ payment_said: "unpaid" })).toBeNull();
    expect(paymentSaid({ invoice: { status: "paid" } })).toBeNull();
    expect(paymentSaid(null)).toBeNull();
  });

  it("says what happened in plain words, with no amounts", () => {
    const who = { name: "Dana Ruiz", category: "invoice_payment" };
    expect(describeActivity("invoice_marked_paid", { source: "owner" }, who)).toBe(
      "You marked Dana's invoice paid",
    );
    expect(describeActivity("invoice_marked_paid", { source: "auto", via: "reply" }, who)).toBe(
      "Marked Dana's invoice paid — they said they paid. Undo on Money owed",
    );
    expect(describeActivity("invoice_marked_paid", { source: "auto", via: "receipt" }, who)).toBe(
      "Marked Dana's invoice paid — a payment receipt matched it. Undo on Money owed",
    );
    expect(describeActivity("invoice_marked_unpaid", { source: "owner" }, who)).toBe(
      "You put Dana's invoice back on the owed list",
    );
    expect(describeActivity("invoice_marked_not_owed", { source: "owner" }, null)).toBe(
      "You said an invoice isn't owed to you",
    );
  });
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let g = 0;

/** A fresh database per test — only for the suites that use one (the rules above don't). */
async function setupDb() {
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
}
const DB_HOOK_TIMEOUT = 30_000;

/**
 * An invoice the owner sent `outAgo` days ago after the customer wrote `inAgo` days ago,
 * already sorted, with its facts on the thread.
 */
async function invoiceThread(
  o: {
    name?: string;
    from?: string;
    invoice?: Partial<InvoiceFacts> | null;
    category?: string;
    inAgo?: number;
    outAgo?: number | null;
    box?: string;
    over?: Partial<typeof threads.$inferInsert>;
  } = {},
) {
  const id = `m${++g}`;
  const inAgo = o.inAgo ?? 6;
  const outAgo = o.outAgo === undefined ? 4 : o.outAgo;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: o.box ?? mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Invoice",
      category: o.category ?? "invoice_payment",
      summary: "About an invoice.",
      classifiedAt: daysAgo(inAgo),
      lastMessageAt: daysAgo(Math.min(inAgo, outAgo ?? Infinity)),
      extracted: {
        service_requested: null,
        address: null,
        dates: [],
        dollar_amounts: [],
        urgency: "normal",
        permit: null,
        invoice: o.invoice === null ? null : inv(o.invoice),
      },
      ...o.over,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId: o.box ?? mailboxId,
    gmailMessageId: `${id}-in`,
    rfc822MessageId: `<${id}-in@customer.com>`,
    direction: "in",
    fromAddress: o.from ?? "dana@customer.com",
    fromName: o.name ?? "Dana Ruiz",
    subject: "Invoice",
    bodyText: "When's the bill?",
    labelIds: ["INBOX"],
    sentAt: daysAgo(inAgo),
    classifiedAt: daysAgo(inAgo),
  });
  if (outAgo !== null) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: o.box ?? mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      references: `<${id}-in@customer.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [o.from ?? "dana@customer.com"],
      subject: "Re: Invoice",
      bodyText: "Invoice attached: $1,200 due Oct 7. Thanks, Davi",
      sentAt: daysAgo(outAgo),
    });
  }
  return t!.id;
}

/** A new, unsorted email on a thread (classifyPending picks it up). */
async function writes(threadId: string, from = "dana@customer.com", name = "Dana Ruiz", ago = 1) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `w${++g}`,
    direction: "in",
    fromAddress: from,
    fromName: name,
    bodyText: "Paid it this morning, thanks!",
    labelIds: ["INBOX"],
    sentAt: daysAgo(ago),
  });
}

/** A Stripe / other receipt arriving as its own thread (unsorted). */
async function receiptThread(from: string) {
  const id = `r${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Receipt",
      lastMessageAt: daysAgo(1),
    })
    .returning();
  await writes(t!.id, from, "Stripe");
  return t!.id;
}

const classifyWith = async (...outputs: unknown[]) => {
  const fake = fakeTransport(outputs);
  setModelTransportForTests(fake.transport);
  await classifyPending(mailboxId, { now: NOW });
  return fake.calls;
};
const paidSays = (
  invoice: Partial<InvoiceFacts>,
  over: Parameters<typeof classification>[0] = {},
) =>
  classification({
    category: "invoice_payment",
    summary: "Says the invoice is paid.",
    ...over,
    extracted: {
      ...classification().extracted,
      service_requested: null,
      invoice: inv({ amount: null, status: "paid", ...invoice }),
      ...over.extracted,
    },
  });
const rowOf = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!;
const paidLogs = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "invoice_marked_paid"));

async function pendingNudge(threadId: string, gmailDraftId = "gd-nudge") {
  const [d] = await database
    .insert(drafts)
    .values({
      threadId,
      mailboxId,
      kind: "followup",
      gmailDraftId,
      toAddress: "dana@customer.com",
      subject: "Re: Invoice",
      body: "Just checking in on the invoice.",
      originalBody: "Just checking in on the invoice.",
      status: "pending",
      reason: "nudge",
      promptVersion: "followup.v3",
      autoSendAt: new Date(NOW.getTime() + 10 * 60_000),
    })
    .returning();
  return d!;
}
const draftOf = async (id: string) =>
  (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

describe("money owed list", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);

  it("lists what's owed, oldest due first, with the customer's name and nudges used", async () => {
    const late = await invoiceThread({
      name: "Dana Ruiz",
      invoice: { amount: 1200, due_date: "2026-09-28", invoice_number: "INV-1" },
    });
    const soon = await invoiceThread({
      name: "Sam Lee",
      from: "sam@customer.com",
      invoice: { amount: 450.5, due_date: "2026-10-20" },
    });
    const partly = await invoiceThread({
      name: "Kim Park",
      from: "kim@customer.com",
      invoice: { amount: 300, due_date: "2026-10-05", status: "partly_paid" },
    });
    await database.update(threads).set({ followupCount: 1 }).where(eq(threads.id, late));
    // Check 12 P5: no amount (and none in the owner's email) is listed last, out of the total.
    const noAmount = await invoiceThread({
      from: "b@c.com",
      invoice: { amount: null },
      outAgo: null,
    });
    // Not on the list: paid per the email, noise, a supplier's bill, a quote.
    await invoiceThread({ from: "a@c.com", invoice: { status: "paid" } });
    await invoiceThread({ from: "c@c.com", category: "noise" });
    // The supplier's bill looks owed in every other way (an invoice thread, an unpaid amount):
    // only its category keeps it off.
    const supplier = await invoiceThread({
      from: "bills@lumber.com",
      category: "supplier_vendor",
      over: {
        extracted: {
          dates: [],
          dollar_amounts: [],
          invoice: inv({ amount: 1200 }),
          invoice_thread: true,
        },
      },
    });
    await invoiceThread({ from: "e@c.com", category: "quote_request" });
    // Another workspace's invoice.
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const otherBox = await saveConnectedMailbox(other, {
      email: "other@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await invoiceThread({ box: otherBox.id, from: "z@c.com", invoice: { amount: 9999 } });

    const money = await listMoney(workspaceId, NOW);
    expect(money.owed.map((r) => r.threadId)).toEqual([late, partly, soon, noAmount]);
    expect(money.owed[0]).toMatchObject({
      customerName: "Dana Ruiz",
      customerAddress: "dana@customer.com",
      amountCents: 120_000,
      invoiceNumber: "INV-1",
      due: { daysPastDue: 12, text: "12 days past due" },
      nudgesUsed: 1,
      paidAt: null,
      mailboxEmail: "owner@shop.com",
    });
    expect(money.owed[2]!.due.text).toBe("Not due yet");
    expect(money.totalOwedCents).toBe(120_000 + 45_050 + 30_000);
    expect(money.paidRecently).toEqual([]);
    expect(money.hidden).toEqual([]);
    for (const list of [money.owed, money.paidRecently, money.hidden])
      expect(list.map((r) => r.threadId)).not.toContain(supplier);
  });

  it("a later email without invoice facts keeps the row and its amount (A11)", async () => {
    const t = await invoiceThread({ invoice: { amount: 1200, invoice_number: "42" } });
    await writes(t);
    await classifyWith(
      classification({ category: "customer_question", summary: "Asks which gate to use." }),
    );
    const { owed } = await listMoney(workspaceId, NOW);
    expect(owed.map((r) => [r.threadId, r.amountCents])).toEqual([[t, 120_000]]);
    expect(invoiceOf((await rowOf(t)).extracted)).toMatchObject({ invoice_number: "42" });
    expect((await rowOf(t)).extracted).toMatchObject({ invoice_thread: true });

    // …and when the customer then says they paid (sorted as a question again), it's paid.
    await writes(t);
    await classifyWith(paidSays({}, { category: "customer_question" }));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");
    expect((await listMoney(workspaceId, NOW)).paidRecently).toMatchObject([
      { threadId: t, amountCents: 120_000 },
    ]);
  });

  it("never shows a receipt sender's own thread, owed or paid (A2)", async () => {
    await invoiceThread({ from: "receipts@stripe.com", invoice: { amount: 199 }, outAgo: null });
    await invoiceThread({
      from: "receipts@stripe.com",
      invoice: { amount: 99, status: "paid" },
      outAgo: null,
      over: { invoicePaidAt: daysAgo(1), invoicePaidSource: "auto" },
    });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toEqual([]);
    expect(money.paidRecently).toEqual([]);
  });

  it("paid rows stay for 30 days so a wrong mark can be undone", async () => {
    const recent = await invoiceThread({
      over: { invoicePaidAt: daysAgo(2), invoicePaidSource: "owner" },
    });
    await invoiceThread({
      from: "old@c.com",
      over: { invoicePaidAt: daysAgo(31), invoicePaidSource: "auto" },
    });
    const { paidRecently, owed } = await listMoney(workspaceId, NOW);
    expect(paidRecently.map((r) => r.threadId)).toEqual([recent]);
    expect(owed).toEqual([]);
  });
});

describe("owner marks", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);

  it("GUARDRAIL: marking paid stops nudges — the scan, the drafter, and the one waiting", async () => {
    const t = await invoiceThread({ inAgo: 6, outAgo: 4 });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
    const d = await pendingNudge(t);
    const writer = new FakeWriter();

    expect(await setInvoicePaid(workspaceId, t, true, NOW, { writerFor: () => writer })).toBe(true);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: NOW, invoicePaidSource: "owner" });
    // The waiting nudge goes, here and in Gmail (A10).
    expect(writer.calls).toEqual(["deleteDraft"]);
    expect(await draftOf(d.id)).toMatchObject({ status: "expired", closedNote: PAID_NOTE });

    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    const fake = fakeTransport([]);
    setModelTransportForTests(fake.transport);
    expect(
      await createDraftForThread(t, {
        trigger: "followup",
        writerFor: () => writer,
        now: () => NOW,
      }),
    ).toEqual({ status: "skipped", reason: "followup_not_allowed" });
    expect(fake.calls).toHaveLength(0);

    const [log] = await paidLogs();
    expect(log).toMatchObject({ actor: "owner", threadId: t, detail: { source: "owner" } });
    const { owed, paidRecently } = await listMoney(workspaceId, NOW);
    expect(owed).toEqual([]);
    expect(paidRecently).toMatchObject([
      { threadId: t, paidSource: "owner", amountCents: 120_000 },
    ]);
  });

  it("GUARDRAIL: the follow-up scan itself skips paid and not-owed invoices (no drafts involved)", async () => {
    // No draft on any of these threads, so only the scan's own invoice_paid_at guard can
    // leave them out (a pending or expired nudge would hide them for another reason).
    const marks: [string, (t: string) => Promise<boolean>][] = [
      ["owner@paid.test", (t) => setInvoicePaid(workspaceId, t, true, NOW)],
      ["auto@paid.test", (t) => autoMarkInvoicePaid(t, "reply", NOW)],
      ["auto@receipt.test", (t) => autoMarkInvoicePaid(t, "receipt", NOW)],
      ["hidden@notowed.test", (t) => setInvoiceNotOwed(workspaceId, t, NOW)],
    ];
    for (const [from, mark] of marks) {
      const t = await invoiceThread({ from, inAgo: 6, outAgo: 4 });
      expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
      expect(await mark(t)).toBe(true);
      expect(await database.select().from(drafts).where(eq(drafts.threadId, t))).toEqual([]);
      expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    }
  });

  it("undo on a paid row with no amount puts it back on the owed list, amount not stated", async () => {
    // "Can you send the invoice?" … "Paid it, thanks": we guessed paid, no figure ever given.
    const t = await invoiceThread({ invoice: { amount: null, status: "paid" } });
    expect(await autoMarkInvoicePaid(t, "reply", NOW)).toBe(true);
    expect((await listMoney(workspaceId, NOW)).paidRecently).toMatchObject([
      { threadId: t, amountCents: null },
    ]);
    expect(await setInvoicePaid(workspaceId, t, false, NOW)).toBe(true);
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([{ threadId: t, amountCents: null }]);
    expect(money.paidRecently).toEqual([]);
    expect(money.totalOwedCents).toBe(0);
    // …and it can be marked paid again from there.
    expect(await setInvoicePaid(workspaceId, t, true, NOW)).toBe(true);
    expect((await listMoney(workspaceId, NOW)).paidRecently.map((r) => r.threadId)).toEqual([t]);
  });

  it("lost Google access: the paid mark stands, the nudge closes, reconnect is asked", async () => {
    const t = await invoiceThread();
    const d = await pendingNudge(t);
    const writer = new FakeWriter();
    writer.deleteDraft = async () => {
      throw new MailboxAuthError();
    };
    expect(await setInvoicePaid(workspaceId, t, true, NOW, { writerFor: () => writer })).toBe(true);
    expect((await rowOf(t)).invoicePaidSource).toBe("owner");
    expect((await draftOf(d.id)).status).toBe("expired");
    const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(box!.status).toBe("reconnect_needed");
  });

  /** A nudge whose Gmail draft really exists, on an account that can send. */
  async function sendableNudge(t: string, writer: FakeWriter) {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const body = "Just checking in on the invoice.";
    const raw = Buffer.from(
      `Subject: Re: Invoice\r\n\r\n${Buffer.from(body).toString("base64")}`,
    ).toString("base64url");
    const { draftId } = await writer.createDraft({ threadId: "gt", raw });
    writer.calls = [];
    return pendingNudge(t, draftId);
  }
  const expiredLogs = () =>
    database.select().from(activityLog).where(eq(activityLog.action, "draft_expired"));

  it("two marks at once close the waiting nudge once: one Gmail delete, one Activity line", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    const slow = writer.deleteDraft.bind(writer);
    writer.deleteDraft = async (id: string) => {
      await new Promise((r) => setTimeout(r, 20));
      await slow(id);
    };
    const opts = { writerFor: () => writer, now: () => NOW };
    const results = await Promise.all([
      expirePendingNudge(t, PAID_NOTE, opts),
      expirePendingNudge(t, PAID_NOTE, opts),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(writer.calls).toEqual(["deleteDraft"]);
    expect(await expiredLogs()).toHaveLength(1);
    expect(await draftOf(d.id)).toMatchObject({ status: "expired", closedNote: PAID_NOTE });
  });

  it("Send tapped while the nudge is being closed: the owner is never told it went when it didn't", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    let tapped: Awaited<ReturnType<typeof queueSend>> | undefined;
    const del = writer.deleteDraft.bind(writer);
    // The owner taps Send on another device while Gmail is deleting the nudge.
    writer.deleteDraft = async (id: string) => {
      tapped = await queueSend(workspaceId, d.id, { writerFor: () => writer, now: () => NOW });
      await del(id);
    };
    expect(
      await expirePendingNudge(t, PAID_NOTE, { writerFor: () => writer, now: () => NOW }),
    ).toBe(true);
    // The close came first, so the tap finds nothing to send — it is not "Reply sent."
    expect(tapped).toEqual({ status: "not_found" });
    const row = await draftOf(d.id);
    expect(row).toMatchObject({ status: "expired", sendAfter: null });
    expect(await expiredLogs()).toHaveLength(1);
    const approved = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "send_approved"));
    expect(approved).toEqual([]);
  });

  const logsOf = (action: string) =>
    database.select().from(activityLog).where(eq(activityLog.action, action));

  it("the nudge is closed in the middle of a Send tap: the tap is not 'Reply sent.' and nothing is queued", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    const opts = { writerFor: () => writer, now: () => NOW };
    const read = writer.getDraft.bind(writer);
    // Gmail hands the tap the text, and "Mark paid" lands on another device before it returns.
    writer.getDraft = async (id: string) => {
      const remote = await read(id);
      expect(await expirePendingNudge(t, PAID_NOTE, opts)).toBe(true);
      return remote;
    };
    const tapped = await queueSend(workspaceId, d.id, opts);
    expect(tapped).toEqual({ status: "not_found" });
    expect(await draftOf(d.id)).toMatchObject({
      status: "expired",
      closedNote: PAID_NOTE,
      sendAfter: null,
    });
    expect(await logsOf("draft_expired")).toHaveLength(1);
    expect(await logsOf("send_approved")).toEqual([]);
  });

  it("the nudge is closed (and its Gmail draft deleted) before the tap reads it: the close stands", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    const opts = { writerFor: () => writer, now: () => NOW };
    const read = writer.getDraft.bind(writer);
    writer.getDraft = async (id: string) => {
      expect(await expirePendingNudge(t, PAID_NOTE, opts)).toBe(true);
      return read(id); // gone from Gmail now
    };
    const tapped = await queueSend(workspaceId, d.id, opts);
    expect(tapped).toEqual({ status: "not_found" });
    // Still the paid close, not "You deleted or sent this draft in Gmail."
    expect(await draftOf(d.id)).toMatchObject({ status: "expired", closedNote: PAID_NOTE });
    expect(await logsOf("draft_expired")).toHaveLength(1);
    expect(await logsOf("draft_discarded")).toEqual([]);
    expect(await logsOf("send_approved")).toEqual([]);
  });

  it("two Send taps at once: the second is told it's already sending", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    const opts = { writerFor: () => writer, now: () => NOW };
    const read = writer.getDraft.bind(writer);
    let second: Awaited<ReturnType<typeof queueSend>> | undefined;
    writer.getDraft = async (id: string) => {
      const remote = await read(id);
      if (!second) {
        second = { status: "not_found" }; // placeholder so the inner tap doesn't recurse
        second = await queueSend(workspaceId, d.id, opts);
      }
      return remote;
    };
    const first = await queueSend(workspaceId, d.id, opts);
    expect(second).toMatchObject({ status: "queued" });
    expect(first).toEqual({ status: "already_sending" });
    expect(await logsOf("send_approved")).toHaveLength(1);
  });

  it("a Send already tapped is left alone: no Gmail delete, no Activity line, still sending", async () => {
    const t = await invoiceThread();
    const writer = new FakeWriter();
    const d = await sendableNudge(t, writer);
    const opts = { writerFor: () => writer, now: () => NOW };
    expect(await queueSend(workspaceId, d.id, opts)).toMatchObject({ status: "queued" });
    writer.calls = [];
    expect(await expirePendingNudge(t, PAID_NOTE, opts)).toBe(false);
    expect(writer.calls).toEqual([]);
    expect(await expiredLogs()).toEqual([]);
    const row = await draftOf(d.id);
    expect(row.status).toBe("pending");
    expect(row.sendAfter).not.toBeNull();
  });

  it("a sent reply on a paid invoice never promises a nudge", async () => {
    const t = await invoiceThread();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t,
        mailboxId,
        kind: "reply",
        gmailDraftId: "gd-sent",
        toAddress: "dana@customer.com",
        subject: "Re: Invoice",
        body: "Thanks!",
        originalBody: "Thanks!",
        status: "sent",
        reason: "reply",
        promptVersion: "draft.v5",
        decidedAt: daysAgo(1),
      })
      .returning();
    expect((await sentDraftSummary(workspaceId, d!.id))!.nudgeOn).not.toBeNull();
    await setInvoicePaid(workspaceId, t, true, NOW);
    expect(await sentDraftSummary(workspaceId, d!.id)).toMatchObject({
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("undo puts it back — even when the email says paid — and our guesses leave it alone", async () => {
    const t = await invoiceThread({ invoice: { amount: 1200, invoice_number: "42" } });
    await setInvoicePaid(workspaceId, t, true, NOW);
    expect(await setInvoicePaid(workspaceId, t, false, NOW)).toBe(true);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: "owner" });
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toEqual([t]);
    const [undo] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "invoice_marked_unpaid"));
    expect(undo).toMatchObject({ actor: "owner", detail: { source: "owner" } });

    // The customer then says "paid" (and the email itself says paid): the owner wins.
    await writes(t);
    await classifyWith(paidSays({}));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: "owner" });
    expect(invoiceOf((await rowOf(t)).extracted)?.status).toBe("paid");
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toEqual([t]);
    expect(await autoMarkInvoicePaid(t, "receipt", NOW)).toBe(false);
    expect((await paidLogs()).filter((l) => l.actor === "squared_away")).toHaveLength(0);
    // It's chased again, like any owed invoice.
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]); // the customer wrote last
  });

  it("a double tap logs once and doesn't restart the Undo window", async () => {
    const t = await invoiceThread();
    const other = await invoiceThread({ from: "sam@customer.com", name: "Sam Lee" });
    const later = new Date(NOW.getTime() + 5_000);
    expect(await setInvoicePaid(workspaceId, t, true, NOW)).toBe(true);
    expect(await setInvoicePaid(workspaceId, t, true, later)).toBe(true);
    expect((await rowOf(t)).invoicePaidAt).toEqual(NOW);
    expect(await paidLogs()).toHaveLength(1);

    expect(await setInvoicePaid(workspaceId, t, false, later)).toBe(true);
    expect(await setInvoicePaid(workspaceId, t, false, later)).toBe(true);
    expect(await setInvoiceNotOwed(workspaceId, t, later)).toBe(true);
    expect(await setInvoiceNotOwed(workspaceId, t, new Date(later.getTime() + 5_000))).toBe(true);
    expect((await rowOf(t)).invoicePaidAt).toEqual(later);
    const logs = await database
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.threadId, t));
    expect(logs.map((l) => l.action).sort()).toEqual([
      "invoice_marked_not_owed",
      "invoice_marked_paid",
      "invoice_marked_unpaid",
    ]);
    // Only that invoice ever changed.
    expect(await rowOf(other)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
  });

  it("undo on our guess takes 'we think this was paid' off the waiting nudge", async () => {
    const t = await invoiceThread();
    const d = await pendingNudge(t);
    expect(await autoMarkInvoicePaid(t, "reply", NOW)).toBe(true);
    expect((await draftOf(d.id)).flags).toEqual([PAID_GUESS_FLAG]);
    expect(await setInvoicePaid(workspaceId, t, false, NOW)).toBe(true);
    const after = await draftOf(d.id);
    expect(after.flags).toEqual([]);
    expect(after.status).toBe("pending");
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toEqual([t]);
  });

  it("marked paid while the nudge was being written → no nudge, no Gmail draft left behind", async () => {
    const t = await invoiceThread({ inAgo: 6, outAgo: 4 });
    const writer = new FakeWriter();
    let modelCalls = 0;
    setModelTransportForTests(async () => {
      modelCalls++;
      // The owner taps Mark paid on Money owed while the model is writing.
      await database
        .update(threads)
        .set({ invoicePaidAt: NOW, invoicePaidSource: "owner" })
        .where(eq(threads.id, t));
      return {
        parsed: {
          body: "Hi Dana,\n\nJust checking in on the invoice.\n\nThanks, Davi",
          reason: "No reply in 4 days to your invoice.",
          flags: [],
          confidence: 0.9,
          used_facts: [],
        },
        stopReason: "end_turn",
        usage: { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });
    expect(
      await createDraftForThread(t, {
        trigger: "followup",
        writerFor: () => writer,
        now: () => NOW,
      }),
    ).toEqual({ status: "skipped", reason: "followup_not_allowed" });
    expect(modelCalls).toBe(1);
    expect(writer.calls).toEqual(["createDraft", "deleteDraft"]);
    expect(writer.drafts.size).toBe(0);
    expect(
      await database
        .select()
        .from(drafts)
        .where(and(eq(drafts.threadId, t), eq(drafts.status, "pending"))),
    ).toEqual([]);
  });

  it("'Not owed to me' hides it from both lists, stops nudges, and Put back undoes it", async () => {
    const t = await invoiceThread();
    const d = await pendingNudge(t);
    const writer = new FakeWriter();
    expect(await setInvoiceNotOwed(workspaceId, t, NOW, { writerFor: () => writer })).toBe(true);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: NOW, invoicePaidSource: "not_owed" });
    expect(writer.calls).toEqual(["deleteDraft"]);
    expect((await draftOf(d.id)).status).toBe("expired");
    let money = await listMoney(workspaceId, NOW);
    expect(money.owed).toEqual([]);
    expect(money.paidRecently).toEqual([]);
    expect(money.hidden.map((r) => r.threadId)).toEqual([t]);
    expect(money.totalOwedCents).toBe(0);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    // Our guess never turns a hidden row into a paid one.
    expect(await autoMarkInvoicePaid(t, "reply", NOW)).toBe(false);

    await setInvoicePaid(workspaceId, t, false, NOW);
    money = await listMoney(workspaceId, NOW);
    expect(money.owed.map((r) => r.threadId)).toEqual([t]);
    expect(money.hidden).toEqual([]);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: "owner" });
  });

  it("GUARDRAIL: read-only accounts can't mark, and get no auto marks", async () => {
    const t = await invoiceThread({ invoice: { invoice_number: "42" } });
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: daysAgo(1) })
      .where(eq(workspaces.id, workspaceId));
    await expect(setInvoicePaid(workspaceId, t, true, NOW)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(setInvoiceNotOwed(workspaceId, t, NOW)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(setInvoicePaid(workspaceId, t, false, NOW)).rejects.toBeInstanceOf(ReadOnlyError);

    await writes(t);
    const r = await receiptThread("receipts@stripe.com");
    const calls = await classifyWith(paidSays({}), paidSays({ invoice_number: "42" }));
    expect(calls).toHaveLength(0);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect((await rowOf(r)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
  });

  it("can't touch another workspace's invoice", async () => {
    const t = await invoiceThread();
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await setInvoicePaid(other.id, t, true, NOW)).toBe(false);
    expect(await setInvoiceNotOwed(other.id, t, NOW)).toBe(false);
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect(await paidLogs()).toEqual([]);
  });
});

describe("auto paid", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);

  it("the customer says they paid → paid (our guess), the amount kept, a content-free log", async () => {
    const t = await invoiceThread({ invoice: { amount: 1200, invoice_number: "INV-42" } });
    await writes(t);
    await classifyWith(paidSays({}));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: NOW, invoicePaidSource: "auto" });
    expect(invoiceOf((await rowOf(t)).extracted)).toMatchObject({
      amount: 1200,
      invoice_number: "INV-42",
      status: "paid",
    });
    const logs = await paidLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspaceId,
      threadId: t,
      actor: "squared_away",
      detail: { source: "auto", via: "reply" },
    });
    expect(JSON.stringify(logs[0]!.detail)).not.toMatch(/1200|1,200|Dana|42/);
    const { owed, paidRecently } = await listMoney(workspaceId, NOW);
    expect(owed).toEqual([]);
    expect(paidRecently).toMatchObject([{ threadId: t, paidSource: "auto", amountCents: 120_000 }]);
    expect((await listActivity(workspaceId))[0]!.text).toBe(
      "Marked Dana's invoice paid — they said they paid. Undo on Money owed",
    );
  });

  it("…also when the 'paid' email is sorted as something else on an invoice thread", async () => {
    const t = await invoiceThread();
    await writes(t);
    await classifyWith(paidSays({}, { category: "customer_question" }));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");
  });

  it("a 'paid' mention on a thread that was never about an invoice marks nothing", async () => {
    const t = await invoiceThread({ category: "scheduling", invoice: null });
    await writes(t);
    await classifyWith(paidSays({}, { category: "scheduling" }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
  });

  it("A8: our guess stops future nudges but leaves the waiting one, flagged, countdown cleared", async () => {
    const t = await invoiceThread();
    const d = await pendingNudge(t);
    await writes(t);
    await classifyWith(paidSays({}));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");
    expect(await draftOf(d.id)).toMatchObject({
      status: "pending",
      gmailDraftId: "gd-nudge",
      flags: [PAID_GUESS_FLAG],
      autoSendAt: null,
    });
    const writer = new FakeWriter();
    setModelTransportForTests(fakeTransport([]).transport);
    expect(
      await createDraftForThread(t, {
        trigger: "followup",
        writerFor: () => writer,
        now: () => NOW,
      }),
    ).toEqual({ status: "skipped", reason: "followup_not_allowed" });
  });

  it("A8: an email that tries to instruct the assistant never marks anything paid", async () => {
    const t = await invoiceThread();
    await writes(t);
    await classifyWith(
      paidSays(
        {},
        {
          signals: { ...classification().signals, tries_to_instruct_assistant: true },
        },
      ),
    );
    const row = await rowOf(t);
    expect((row.extracted as { injection?: boolean }).injection).toBe(true);
    expect(row.invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
    // Its "paid" never reaches the stored facts either, so the row stays owed (and visible),
    // rather than silently dropping off both lists.
    expect(invoiceOf(row.extracted)).toMatchObject({ amount: 1200, status: "unpaid" });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([{ threadId: t, amountCents: 120_000 }]);
    expect(money.totalOwedCents).toBe(120_000);
  });

  it("A8: an instructing email can't swap in a new invoice number or clear a paid mark", async () => {
    const t = await invoiceThread({ invoice: { amount: 900, invoice_number: "41" } });
    await setInvoicePaid(workspaceId, t, true, daysAgo(2));
    await writes(t);
    await classifyWith(
      paidSays(
        { invoice_number: "42", amount: 5000, status: "unpaid" },
        { signals: { ...classification().signals, tries_to_instruct_assistant: true } },
      ),
    );
    const row = await rowOf(t);
    expect(row).toMatchObject({ invoicePaidSource: "owner", invoicePaidAt: daysAgo(2) });
    expect(invoiceOf(row.extracted)).toMatchObject({ invoice_number: "41", amount: 900 });
  });

  it("A14: idempotent — a second guess changes nothing and logs nothing", async () => {
    const t = await invoiceThread();
    expect(await autoMarkInvoicePaid(t, "reply", NOW)).toBe(true);
    expect(await autoMarkInvoicePaid(t, "reply", new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(await autoMarkInvoicePaid(t, "receipt", NOW)).toBe(false);
    expect(await paidLogs()).toHaveLength(1);
    expect((await rowOf(t)).invoicePaidAt).toEqual(NOW);
    // The owner's mark after ours is the owner's.
    await setInvoicePaid(workspaceId, t, false, NOW);
    expect(await autoMarkInvoicePaid(t, "reply", NOW)).toBe(false);
  });

  it("a Stripe receipt naming the invoice number marks THAT invoice paid — not its own thread", async () => {
    const dana = await invoiceThread({ invoice: { amount: 1200, invoice_number: "INV-0042" } });
    const sam = await invoiceThread({
      from: "sam@customer.com",
      name: "Sam Lee",
      invoice: { amount: 1200, invoice_number: "INV-0043" },
    });
    const r = await receiptThread("receipts@stripe.com");
    await classifyWith(paidSays({ invoice_number: "#42", amount: 1200 }));
    expect(await rowOf(dana)).toMatchObject({ invoicePaidAt: NOW, invoicePaidSource: "auto" });
    expect((await rowOf(sam)).invoicePaidAt).toBeNull();
    // The receipt's own thread is never a customer: never paid, owed or listed.
    expect(await rowOf(r)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    const logs = await paidLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ threadId: dana, detail: { source: "auto", via: "receipt" } });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed.map((x) => x.threadId)).toEqual([sam]);
    expect(money.paidRecently.map((x) => x.threadId)).toEqual([dana]);
  });

  it("A12: a receipt with no invoice number marks nothing, even with a unique matching amount", async () => {
    const t = await invoiceThread({ invoice: { amount: 199 } });
    await receiptThread("receipts@stripe.com");
    await classifyWith(paidSays({ amount: 199 }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
  });

  it("an ambiguous receipt marks nothing", async () => {
    const a = await invoiceThread({ invoice: { invoice_number: "42" } });
    const b = await invoiceThread({ from: "b@c.com", invoice: { invoice_number: "INV-42" } });
    await receiptThread("receipts@stripe.com");
    await classifyWith(paidSays({ invoice_number: "42" }));
    expect((await rowOf(a)).invoicePaidAt).toBeNull();
    expect((await rowOf(b)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
  });

  it("a receipt from a look-alike domain never marks a customer's invoice", async () => {
    const t = await invoiceThread({ invoice: { invoice_number: "INV-0042" } });
    await receiptThread("receipts@stripe.com.evil.test");
    await classifyWith(paidSays({ invoice_number: "#42" }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    const logs = await paidLogs();
    expect(logs.some((l) => (l.detail as { via?: string }).via === "receipt")).toBe(false);
    expect(logs.map((l) => l.threadId)).not.toContain(t);
  });

  it("a receipt for the owner's own purchase, or for a different amount, marks nothing", async () => {
    // QuickBooks numbers every company's invoices from 1001.
    const t = await invoiceThread({ invoice: { amount: 1200, invoice_number: "1037" } });
    await receiptThread("payments@intuit.com");
    await classifyWith(paidSays({ invoice_number: "1037", amount: 845 }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    await receiptThread("payments@intuit.com");
    await classifyWith(
      paidSays({ invoice_number: "1037", amount: 1200 }, { category: "supplier_vendor" }),
    );
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toEqual([t]);
  });

  it("a new invoice number after a paid one is owed again — and chased again", async () => {
    const t = await invoiceThread({
      inAgo: 12,
      outAgo: 11,
      invoice: { amount: 900, invoice_number: "#41" },
    });
    await writes(t, "dana@customer.com", "Dana Ruiz", 10);
    await classifyWith(paidSays({ invoice_number: "41" }));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");

    // Same thread, phase 2: "Got invoice #42, $1,500, will pay by Nov 30."
    await writes(t, "dana@customer.com", "Dana Ruiz", 9);
    await classifyWith(
      paidSays({ invoice_number: "INV-42", amount: 1500, due_date: "Nov 30", status: "unpaid" }),
    );
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      { threadId: t, amountCents: 150_000, invoiceNumber: "INV-42", due: { text: "Not due yet" } },
    ]);
    expect(money.totalOwedCents).toBe(150_000);
    expect(money.paidRecently).toEqual([]);

    // The owner answers; nothing back for days → it's chased like any owed invoice.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `o${++g}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      bodyText: "Thanks Dana.",
      sentAt: daysAgo(5),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
  });

  it("…also after the owner's own Mark paid on the earlier invoice — and Activity says why", async () => {
    const t = await invoiceThread({ invoice: { amount: 900, invoice_number: "41" } });
    await setInvoicePaid(workspaceId, t, true, daysAgo(3));
    await writes(t);
    await classifyWith(paidSays({ invoice_number: "42", amount: 1500, status: "unpaid" }));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    const money = await listMoney(workspaceId, NOW);
    // #41 was marked paid, so only #42 is owed.
    expect(money.owed).toMatchObject([{ threadId: t, amountCents: 150_000, earlierOpen: [] }]);
    expect(money.totalOwedCents).toBe(150_000);
    // The owner's mark never just disappears: one content-free line explains it.
    const reopened = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "invoice_reopened"));
    expect(reopened).toMatchObject([
      { actor: "squared_away", threadId: t, detail: { source: "auto", why: "new_invoice" } },
    ]);
    expect(JSON.stringify(reopened[0]!.detail)).not.toMatch(/1500|1,500|42|Dana/);
    expect((await listActivity(workspaceId))[0]!.text).toBe(
      "Dana's conversation mentions a new invoice, so it's back on Money owed",
    );
  });

  it("GUARDRAIL: 'Not owed to me' survives a new invoice number — never back on the list, never chased", async () => {
    // A supplier's statement thread sorted as an invoice; the owner hid it.
    const t = await invoiceThread({
      from: "billing@lumber.test",
      inAgo: 12,
      outAgo: 11,
      invoice: { amount: 420, invoice_number: "5512" },
    });
    await setInvoiceNotOwed(workspaceId, t, daysAgo(10));
    // Next month, same thread: "Invoice 5513, $640, due Nov 30".
    await writes(t, "billing@lumber.test", "Lumber Co", 9);
    await classifyWith(
      paidSays({ invoice_number: "5513", amount: 640, due_date: "Nov 30", status: "unpaid" }),
    );
    expect(await rowOf(t)).toMatchObject({
      invoicePaidSource: "not_owed",
      invoicePaidAt: daysAgo(10),
    });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toEqual([]);
    expect(money.totalOwedCents).toBe(0);
    expect(money.hidden.map((r) => r.threadId)).toEqual([t]);
    // The owner replies; days pass with no answer → still never chased.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `o${++g}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["billing@lumber.test"],
      bodyText: "Thanks.",
      sentAt: daysAgo(5),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(
      await database.select().from(activityLog).where(eq(activityLog.action, "invoice_reopened")),
    ).toEqual([]);
  });

  it("a second invoice on the thread while the first is unpaid keeps both on the total", async () => {
    // Deposit invoice #41 ($900, unpaid), then "Got #42 for phase 2, will pay both Friday".
    const t = await invoiceThread({ invoice: { amount: 900, invoice_number: "41" } });
    await writes(t, "dana@customer.com", "Dana Ruiz", 2);
    await classifyWith(paidSays({ invoice_number: "42", amount: 1500, status: "unpaid" }));
    let money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      {
        threadId: t,
        amountCents: 150_000,
        invoiceNumber: "42",
        earlierOpen: [{ invoiceNumber: "41", amountCents: 90_000 }],
      },
    ]);
    expect(money.totalOwedCents).toBe(240_000);

    // "Paid #41 today": that one is settled, #42 is still owed — the thread isn't paid.
    await writes(t, "dana@customer.com", "Dana Ruiz", 1);
    await classifyWith(paidSays({ invoice_number: "INV-41" }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([{ threadId: t, amountCents: 150_000, earlierOpen: [] }]);
    expect(money.totalOwedCents).toBe(150_000);
    expect(await paidLogs()).toEqual([]);
  });

  it("the same invoice number again keeps the paid mark", async () => {
    const t = await invoiceThread({ invoice: { amount: 900, invoice_number: "41" } });
    await setInvoicePaid(workspaceId, t, true, daysAgo(3));
    await writes(t);
    await classifyWith(paidSays({ invoice_number: "INV-0041", status: "unpaid" }));
    expect((await rowOf(t)).invoicePaidSource).toBe("owner");
    expect((await listMoney(workspaceId, NOW)).owed).toEqual([]);
  });

  it("GUARDRAIL: a deposit is not the job being paid — the first invoice fact on a quote marks nothing", async () => {
    // The owner quoted; Dana: "Let's do it, just sent the $500 deposit by Zelle."
    const t = await invoiceThread({
      category: "quote_request",
      invoice: null,
      inAgo: 12,
      outAgo: 11,
    });
    await writes(t, "dana@customer.com", "Dana Ruiz", 10);
    await classifyWith(
      paidSays({ amount: 500 }, { signals: { ...classification().signals, accepts_quote: true } }),
    );
    let row = await rowOf(t);
    expect(row).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect(await paidLogs()).toEqual([]);
    // The facts are kept, and what the email said about paying.
    expect(invoiceOf(row.extracted)).toMatchObject({ amount: 500, status: "paid" });
    expect(row.extracted).toMatchObject({ payment_said: "paid", invoice_thread: true });
    let money = await listMoney(workspaceId, NOW);
    expect(money.owed).toEqual([]);
    expect(money.paidRecently).toEqual([]);
    // The owner says thanks; a customer who just paid is never chased.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `o${++g}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      bodyText: "Got it, thanks Dana. See you Monday.",
      sentAt: daysAgo(9),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);

    // Later: "Got invoice #1043 for $3,000, will pay next week" — owed, and chased.
    await writes(t, "dana@customer.com", "Dana Ruiz", 8);
    await classifyWith(paidSays({ invoice_number: "1043", amount: 3000, status: "unpaid" }));
    row = await rowOf(t);
    expect(row.extracted).not.toHaveProperty("payment_said");
    money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      { threadId: t, amountCents: 300_000, invoiceNumber: "1043" },
    ]);
    expect(money.totalOwedCents).toBe(300_000);
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `o${++g}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      bodyText: "Thanks Dana.",
      sentAt: daysAgo(5),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
  });

  it("our paid guess on a deposit with no number is cleared by the job's invoice (#1043 $3,000)", async () => {
    // A deposit invoice ($900, no number) was owed, and Dana said she paid it.
    const t = await invoiceThread({ inAgo: 12, outAgo: 11, invoice: { amount: 900 } });
    await writes(t, "dana@customer.com", "Dana Ruiz", 10);
    await classifyWith(paidSays({ amount: 900 }));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");

    await writes(t, "dana@customer.com", "Dana Ruiz", 9);
    await classifyWith(paidSays({ invoice_number: "1043", amount: 3000, status: "unpaid" }));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      { threadId: t, amountCents: 300_000, invoiceNumber: "1043" },
    ]);
    expect(money.paidRecently).toEqual([]);
    expect(
      await database.select().from(activityLog).where(eq(activityLog.action, "invoice_reopened")),
    ).toMatchObject([{ threadId: t, detail: { source: "auto", why: "new_invoice" } }]);
  });

  it("'Paid invoice 42' while #41 is still open: #41 stays owed, the thread isn't marked paid", async () => {
    const t = await invoiceThread({
      invoice: {
        invoice_number: "42",
        amount: 2000,
        earlier_open: [{ invoice_number: "41", amount: 500 }],
      },
    });
    await writes(t);
    await classifyWith(paidSays({ invoice_number: "42" }));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect(await paidLogs()).toEqual([]);
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      { threadId: t, amountCents: 50_000, invoiceNumber: "41", earlierOpen: [] },
    ]);
    expect(money.totalOwedCents).toBe(50_000);
  });

  it("'Paid invoice 43 ($800)' while #42's $2,000 is open: #42 stays owed, nothing marked paid", async () => {
    const t = await invoiceThread({ invoice: { invoice_number: "42", amount: 2000 } });
    await writes(t);
    await classifyWith(paidSays({ invoice_number: "43", amount: 800 }));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect(await paidLogs()).toEqual([]);
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      { threadId: t, amountCents: 200_000, invoiceNumber: "42", earlierOpen: [] },
    ]);
    expect(money.totalOwedCents).toBe(200_000);
  });

  it("an invoice waiting with no amount ('Got it, will pay Friday'), then 'Paid it': our paid guess", async () => {
    const t = await invoiceThread({ invoice: { invoice_number: "1043", amount: null } });
    // Check 12 P5: it's owed, with the amount from the owner's own invoice email.
    expect((await listMoney(workspaceId, NOW)).owed).toMatchObject([
      { threadId: t, amountCents: 120_000, amountFromYourEmail: true },
    ]);
    await writes(t);
    await classifyWith(paidSays({}));
    expect((await rowOf(t)).invoicePaidSource).toBe("auto");
    expect(await paidLogs()).toHaveLength(1);
  });

  it("…and a receipt for #42 does the same", async () => {
    const t = await invoiceThread({
      invoice: {
        invoice_number: "42",
        amount: 2000,
        earlier_open: [{ invoice_number: "41", amount: 500 }],
      },
    });
    await receiptThread("receipts@stripe.com");
    await classifyWith(paidSays({ invoice_number: "INV-42", amount: 2000 }));
    expect(await rowOf(t)).toMatchObject({ invoicePaidAt: null, invoicePaidSource: null });
    expect(invoiceOf((await rowOf(t)).extracted)).toMatchObject({
      invoice_number: "41",
      amount: 500,
      status: "unpaid",
    });
    expect(await paidLogs()).toEqual([]);
    expect((await listMoney(workspaceId, NOW)).totalOwedCents).toBe(50_000);
  });

  it("a new invoice with no amount keeps the earlier open one on the list and the total", async () => {
    const t = await invoiceThread({ invoice: { invoice_number: "41", amount: 500 } });
    await writes(t);
    // "Got invoice #42 for phase 2, thanks" — no amount.
    await classifyWith(paidSays({ invoice_number: "42", amount: null, status: "unpaid" }));
    const money = await listMoney(workspaceId, NOW);
    expect(money.owed).toMatchObject([
      {
        threadId: t,
        amountCents: null,
        invoiceNumber: "42",
        earlierOpen: [{ invoiceNumber: "41", amountCents: 50_000 }],
      },
    ]);
    expect(money.totalOwedCents).toBe(50_000);
  });
});

describe("Check 12 P5: invoices with no amount yet", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);
  const ownerSends = (threadId: string, bodyText: string, ago = 3) =>
    database.insert(messages).values({
      threadId,
      mailboxId,
      gmailMessageId: `os${++g}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      bodyText,
      sentAt: daysAgo(ago),
    });

  it("'Got your invoice, I'll pay Friday' is owed, with no amount and out of the total", async () => {
    const t = await invoiceThread({ invoice: { amount: null }, outAgo: null });
    const other = await invoiceThread({ from: "sam@customer.com", invoice: { amount: 300 } });
    const { owed, totalOwedCents } = await listMoney(workspaceId, NOW);
    expect(owed.map((r) => r.threadId).sort()).toEqual([t, other].sort());
    expect(owed.find((r) => r.threadId === t)).toMatchObject({
      amountCents: null,
      amountFromYourEmail: false,
    });
    expect(totalOwedCents).toBe(30_000);
  });

  it("takes the amount from the owner's own invoice email, labelled — never from quoted customer text", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    const t = await invoiceThread({ invoice: { amount: null }, outAgo: null });
    await ownerSends(t, "Hi Dana, invoice 1043 attached: $1,850 for the panel work. Thanks!");
    const quoted = await invoiceThread({
      from: "kim@customer.com",
      invoice: { amount: null },
      outAgo: null,
    });
    await ownerSends(
      quoted,
      "Thanks Kim!\n\nOn Mon, Oct 5, 2026, Kim wrote:\n> I'll send the $900 Friday",
    );
    const { owed, totalOwedCents } = await listMoney(workspaceId, NOW);
    expect(owed.find((r) => r.threadId === t)).toMatchObject({
      amountCents: 185_000,
      amountFromYourEmail: true,
    });
    expect(owed.find((r) => r.threadId === quoted)).toMatchObject({ amountCents: null });
    expect(totalOwedCents).toBe(185_000);
    // Idempotent, and it never writes over an amount.
    const { captureInvoiceAmounts } = await import("@/server/money");
    expect(await captureInvoiceAmounts()).toBe(0);
    for (const spy of spies) {
      const said = JSON.stringify(spy.mock.calls);
      expect(said).not.toMatch(/1,?850|Dana|Kim|900/);
      spy.mockRestore();
    }
  });

  it("an inbound email never supplies the amount", async () => {
    const t = await invoiceThread({ invoice: { amount: null }, outAgo: null });
    await writes(t); // the customer's own words, with no figure the owner wrote
    await database
      .update(messages)
      .set({ bodyText: "I'll pay the $2,000 Friday." })
      .where(and(eq(messages.threadId, t), eq(messages.direction, "in")));
    expect((await listMoney(workspaceId, NOW)).owed[0]).toMatchObject({ amountCents: null });
  });
});

describe("Check 12 P4: bills the owner owes stay off Money owed", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);

  it("the rule: owed_by_business, or unclear and from a supplier / a 'Not owed to me' sender", () => {
    const b = (o: Partial<Parameters<typeof billOwedByOwner>[0]>) =>
      billOwedByOwner({
        direction: undefined,
        ownerMarked: false,
        senderHasSupplierThread: false,
        senderMarkedNotOwed: false,
        ...o,
      });
    expect(b({ direction: "owed_by_business" })).toBe(true);
    expect(b({})).toBe(false);
    expect(b({ direction: "unknown", senderHasSupplierThread: true })).toBe(true);
    expect(b({ senderMarkedNotOwed: true })).toBe(true);
    // A clear "owed to you", or the owner's own mark on this thread, wins.
    expect(b({ direction: "owed_to_business", senderHasSupplierThread: true })).toBe(false);
    expect(b({ ownerMarked: true, senderHasSupplierThread: true })).toBe(false);
    expect(b({ ownerMarked: true, direction: "owed_by_business" })).toBe(true);
  });

  it("an unknown-direction bill from a supplier's domain is not owed to you, and never nudged", async () => {
    // The supply house has a thread sorted supplier_vendor (an order confirmation).
    await invoiceThread({
      from: "orders@northside-supply.test",
      name: "Northside",
      category: "supplier_vendor",
      invoice: null,
    });
    const bill = await invoiceThread({
      from: "billing@northside-supply.test",
      name: "Northside Billing",
      invoice: { amount: 1240, invoice_number: "55120", due_date: "2026-11-01" },
      inAgo: 9,
      outAgo: 8,
    });
    const customer = await invoiceThread({ invoice: { amount: 900 }, inAgo: 9, outAgo: 8 });
    const { owed, totalOwedCents } = await listMoney(workspaceId, NOW);
    expect(owed.map((r) => r.threadId)).toEqual([customer]);
    expect(totalOwedCents).toBe(90_000);
    const chased = await threadsToFollowUp(mailboxId, NOW);
    expect(chased).toContain(customer);
    expect(chased).not.toContain(bill);
    // The owner's "Put back" on it wins.
    await setInvoicePaid(workspaceId, bill, false, NOW);
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toContain(bill);
  });

  it("'Not owed to me' on one bill keeps that sender's later bills off the list", async () => {
    const first = await invoiceThread({ from: "ap@sub-electric.test", invoice: { amount: 500 } });
    await setInvoiceNotOwed(workspaceId, first, NOW);
    const second = await invoiceThread({ from: "ap@sub-electric.test", invoice: { amount: 700 } });
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).not.toContain(second);
    // On public webmail only the same address counts, never the whole domain.
    const gm = await invoiceThread({ from: "plumbsupply@gmail.com", invoice: { amount: 100 } });
    await setInvoiceNotOwed(workspaceId, gm, NOW);
    const customer = await invoiceThread({ from: "dana@gmail.com", invoice: { amount: 300 } });
    expect((await listMoney(workspaceId, NOW)).owed.map((r) => r.threadId)).toContain(customer);
  });

  it("a QuickBooks receipt for the owner's own supplier bill 1037 marks nothing", async () => {
    const t = await invoiceThread({ invoice: { amount: 412, invoice_number: "1037" } });
    await receiptThread("payments@intuit.com");
    await classifyWith(
      paidSays(
        { invoice_number: "1037", amount: 412 },
        {
          extracted: {
            ...classification().extracted,
            service_requested: null,
            invoice: inv({ invoice_number: "1037", amount: 412, status: "paid" }),
            invoice_direction: "owed_by_business",
          },
        },
      ),
    );
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
  });

  it("a receipt without an amount marks nothing, even with a matching number", async () => {
    const t = await invoiceThread({ invoice: { amount: 1200, invoice_number: "INV-0042" } });
    await receiptThread("receipts@stripe.com");
    await classifyWith(paidSays({ invoice_number: "#42", amount: null }));
    expect((await rowOf(t)).invoicePaidAt).toBeNull();
    expect(await paidLogs()).toEqual([]);
  });

  it("the SQL twin agrees with billOwedByOwner", async () => {
    await invoiceThread({ from: "orders@supply.test", category: "supplier_vendor", invoice: null });
    const cases = [
      { from: "a@supply.test", dir: "unknown", src: null },
      { from: "b@supply.test", dir: "owed_to_business", src: null },
      { from: "c@supply.test", dir: undefined, src: "owner" },
      { from: "d@other.test", dir: "owed_by_business", src: null },
      { from: "e@other.test", dir: undefined, src: null },
    ] as const;
    const ids: string[] = [];
    for (const c of cases) {
      const id = await invoiceThread({ from: c.from, invoice: { amount: 10 } });
      await database
        .update(threads)
        .set({
          extracted: c.dir ? { bill_direction: c.dir } : {},
          invoicePaidSource: c.src,
          invoicePaidAt: null,
        })
        .where(eq(threads.id, id));
      ids.push(id);
    }
    const rows = await database
      .select({
        id: threads.id,
        sql: sql<boolean>`${billOwedByOwnerSql()}`,
        supplier: sql<boolean>`${senderHasSupplierThreadSql()}`,
        notOwed: sql<boolean>`${senderMarkedNotOwedSql()}`,
      })
      .from(threads);
    const by = new Map(rows.map((r) => [r.id, r]));
    const got = cases.map((c, i) => {
      const r = by.get(ids[i]!)!;
      return [
        r.sql,
        billOwedByOwner({
          direction: c.dir,
          ownerMarked: c.src === "owner",
          senderHasSupplierThread: r.supplier,
          senderMarkedNotOwed: r.notOwed,
        }),
      ];
    });
    expect(got.map(([a, b]) => a === b)).toEqual(cases.map(() => true));
    expect(got.map(([a]) => a)).toEqual([true, false, false, true, false]);
  });
});

describe("privacy: invoice facts stay on the owner's screen", () => {
  beforeEach(setupDb, DB_HOOK_TIMEOUT);

  it("never reach phone notifications or text alerts; the morning summary gets totals only", async () => {
    await invoiceThread({
      name: "Zelda Secretname",
      from: "zelda@customer.com",
      invoice: { amount: 98765, invoice_number: "SECRET-INV", due_date: "2026-09-01" },
      over: { needsOwner: true, needsOwnerReason: "Big amount." },
    });
    const counts = await digestCounts(workspaceId, NOW);
    const digest = buildDigest(
      counts,
      {
        queueUrl: "https://app.example/queue",
        quotesUrl: "https://app.example/quotes",
        settingsUrl: "https://app.example/settings",
        threadUrl: (id) => queueThreadUrl("https://app.example/queue", id),
      },
      { now: NOW, timeZone: "America/New_York" },
    );
    const push = pushSummaryText({
      replies: counts.repliesReady,
      needsYou: counts.needsYou.length,
    });
    const sms = leadAlertBody(
      { quotes: 0, needsYou: counts.needsYou.length },
      "https://app.example",
    );
    const out = JSON.stringify({ push, sms });
    for (const leak of ["98765", "987.65", "98,765", "SECRET", "Zelda", "zelda@"]) {
      expect(out).not.toContain(leak);
    }
    // Replies package (Davi, 2026-10-16: money in the morning email): the month's money
    // TOTALS may go in it — here the one open invoice is the whole total — but never a name,
    // an invoice number or a due date, and the amount only inside the total's own line.
    const mail = JSON.stringify(digest);
    for (const leak of ["SECRET", "Zelda", "zelda@", "2026-09-01", "987.65"]) {
      expect(mail).not.toContain(leak);
    }
    expect(digest.text.split("\n").filter((l) => /98,?765/.test(l))).toEqual([
      "Still owed to you: $98,765 on Money owed.",
    ]);
    expect(counts.needsYou).toHaveLength(1); // the thread was counted, just not described
  });
});
