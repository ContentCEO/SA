/**
 * Money owed rules (plan #27). Pure functions: the list is built from invoice facts the
 * sorter already pulled out of the owner's email (`extracted.invoice`), plus the owner's
 * one-tap "Mark paid" / "Undo" / "Not owed to me" and our guesses, which the owner can
 * always undo. No accounting connection.
 */

/**
 * Payment processors whose receipts can tell us a customer's invoice was paid. A receipt
 * only ever marks ANOTHER thread (one whose invoice number it names, A12); its own thread
 * is never a customer, never owed and never paid (A2).
 */
export const RECEIPT_SENDER_DOMAINS = ["stripe.com", "quickbooks.com", "intuit.com"] as const;

/** The domain part of an address, lowercased ("Name <a@b.com>" works too). */
function domainOf(address: string | null | undefined): string | null {
  const s = (address ?? "").trim().toLowerCase().replace(/>$/, "");
  const at = s.lastIndexOf("@");
  if (at < 0) return null;
  const domain = s.slice(at + 1).trim();
  return domain || null;
}

/** From one of the receipt domains, or a subdomain of one (never a look-alike). */
export function isReceiptSender(address: string | null | undefined): boolean {
  const domain = domainOf(address);
  if (!domain) return false;
  return RECEIPT_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * One invoice number, however it was written: "INV-0042", "Invoice #42", "#42" and "42"
 * all become "42". Null when nothing is left.
 */
export function normalizeInvoiceNumber(s: string | null | undefined): string | null {
  const alnum = (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const bare = alnum.replace(/^(invoice|inv)(number|num|no)?/, "").replace(/^0+/, "");
  return bare || null;
}

export const INVOICE_STATUSES = ["unpaid", "paid", "partly_paid", "unknown"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceFacts = {
  invoice_number: string | null;
  /** In dollars, as the sorter read it. */
  amount: number | null;
  /** As written in the email. */
  due_date: string | null;
  status: InvoiceStatus;
  /**
   * Earlier invoices on the same thread that were still owed when a new number arrived
   * ("Got #42 for phase 2" while the #41 deposit was unpaid). We keep one invoice per
   * thread, so these are shown on its card and counted in the total rather than silently
   * dropped. Never set by the model; only by `carryInvoiceFacts`.
   */
  earlier_open?: EarlierInvoice[];
};
export type EarlierInvoice = { invoice_number: string | null; amount: number | null };
/** At most this many earlier open invoices are kept on one thread. */
const MAX_EARLIER_OPEN = 5;

/** `extracted.invoice`, read loosely (old rows and odd values never throw). */
export function invoiceOf(extracted: unknown): InvoiceFacts | null {
  const inv = (extracted as { invoice?: unknown } | null | undefined)?.invoice;
  if (!inv || typeof inv !== "object") return null;
  const r = inv as Record<string, unknown>;
  const amount = positive(r.amount);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const earlier = Array.isArray(r.earlier_open)
    ? r.earlier_open
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({ invoice_number: str(e.invoice_number), amount: positive(e.amount) }))
        .filter((e) => e.amount !== null)
    : [];
  return {
    invoice_number: str(r.invoice_number),
    amount,
    due_date: str(r.due_date),
    status: (INVOICE_STATUSES as readonly unknown[]).includes(r.status)
      ? (r.status as InvoiceStatus)
      : "unknown",
    ...(earlier.length ? { earlier_open: earlier.slice(-MAX_EARLIER_OPEN) } : {}),
  };
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * A thread that is (or was) about an invoice: sorted invoice_payment now, or at some point
 * before (`extracted.invoice_thread`, kept from one classification to the next).
 */
export function isInvoiceThread(t: { category: string | null; extracted: unknown }): boolean {
  return (
    t.category === "invoice_payment" ||
    (t.extracted as { invoice_thread?: unknown } | null | undefined)?.invoice_thread === true
  );
}

/** Dollars → cents (never a fraction of a cent). */
export const toCents = (dollars: number) => Math.round(dollars * 100);

/**
 * Still owed: nobody has marked it paid (or hidden it), and either the owner put it back on
 * the list ("Undo" / "Put back") — which beats whatever the email said, amount or not — or
 * there's an amount and the email says unpaid / partly paid.
 */
export function isOwed(f: {
  invoice: InvoiceFacts | null;
  paidAt: Date | null;
  paidSource: string | null;
}): boolean {
  if (f.paidAt) return false;
  if (f.paidSource === "owner") return true;
  return holdsOwedInvoice(f.invoice);
}

/**
 * The invoice facts themselves say money is owed, whatever the marks: the current invoice
 * has an amount and is unpaid / partly paid, or an earlier invoice on the thread is still
 * open (`earlier_open` only ever holds entries with an amount). "Got #42 for phase 2" with
 * no amount, while #41's $500 is open, still owes the $500.
 */
export function holdsOwedInvoice(invoice: InvoiceFacts | null): boolean {
  if (!invoice) return false;
  if ((invoice.earlier_open ?? []).some((e) => (e.amount ?? 0) > 0)) return true;
  if (!(invoice.amount && invoice.amount > 0)) return false;
  return invoice.status === "unpaid" || invoice.status === "partly_paid";
}

/**
 * Before a customer's "paid", the thread already had an invoice waiting to be paid: the
 * current one says unpaid / partly paid (with or without an amount — "Got your invoice,
 * will pay Friday"), or an earlier one is still open. Only then can "Paid it, thanks" mark
 * the thread paid. Unlike `holdsOwedInvoice` no amount is needed: this decides the paid
 * guess, not what shows on Money owed. A first invoice fact (nothing stored, or only
 * paid / unknown) never qualifies — "Let's do it, sent the $500 deposit" on a quote thread
 * is not the job being paid.
 */
export function invoiceWasOpen(invoice: InvoiceFacts | null): boolean {
  if (!invoice) return false;
  if ((invoice.earlier_open ?? []).length > 0) return true;
  return invoice.status === "unpaid" || invoice.status === "partly_paid";
}

/** What a row adds to the total owed: its invoice plus any earlier ones still open, in cents. */
export function owedCents(invoice: InvoiceFacts | null): number {
  if (!invoice) return 0;
  const earlier = (invoice.earlier_open ?? []).reduce((t, e) => t + toCents(e.amount ?? 0), 0);
  return toCents(invoice.amount ?? 0) + earlier;
}

const DAY_MS = 86_400_000;

/** The owner's local calendar date (YYYY-MM-DD) in their time zone; Eastern if it's invalid. */
export function localDate(now: Date, timeZone: string): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Days since 1970 for a YYYY-MM-DD date (a calendar date, no time of day). */
function dayNumber(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
/** "Oct 7", "October 7th, 2026" */
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+${DAY}\\b(?:,?\\s+(\\d{4}))?`, "i");
/** "7 Oct", "7th October 2026" */
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?`, "i");
/** US "11/3", "11/03/2026", "11/3/26" */
const SLASHED = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/;

function ymdDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  // 31 Feb is not a date.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return Math.round(t / DAY_MS);
}

/** An invoice is rarely due more than about four months after today. */
const MAX_DAYS_AHEAD = 122;

/**
 * A date written without a year ("Jan 5", "12/28"): the latest year that doesn't put it
 * more than about four months after the day the email was written (`anchor`). So "Jan 5"
 * written on Dec 20 is next month, not 349 days late, and "Dec 28" written on Jan 3 is
 * last month, not next December. Anchored to the email, not to today, so an invoice
 * forgotten for most of a year still reads as months past due, not "Not due yet".
 */
function yearlessDay(month: number, day: number, anchor: number, anchorYear: number) {
  for (const y of [anchorYear + 1, anchorYear, anchorYear - 1]) {
    const d = ymdDay(y, month, day);
    if (d !== null && d - anchor <= MAX_DAYS_AHEAD) return d;
  }
  return null;
}

/**
 * The due date as a calendar date. Only clear dates count ("2026-11-03", "Nov 3",
 * "3 November 2026", "11/3/2026"); a date with no year is placed in the year nearest the
 * day the email was written (`yearlessDay`). Anything else ("net 30", "upon receipt") is
 * no due date — never a guess.
 */
function dueDay(dueDate: string, anchor: number, anchorYear: number): number | null {
  const text = dueDate.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return ymdDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const on = (y: string | undefined, month: number, day: number) =>
    !y
      ? yearlessDay(month, day, anchor, anchorYear)
      : ymdDay(y.length === 2 ? 2000 + Number(y) : Number(y), month, day);
  let m = MONTH_DAY.exec(text);
  if (m) return on(m[3], MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2]));
  m = DAY_MONTH.exec(text);
  if (m) return on(m[3], MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1]));
  m = SLASHED.exec(text);
  if (m) return on(m[3], Number(m[1]), Number(m[2]));
  return null;
}

/**
 * How the due date reads to the owner, from their own calendar day: "No due date",
 * "Not due yet", "Due today" or "12 days past due". `daysPastDue` is negative before the
 * due date and null without one. `writtenAt` is when the email was written (the thread's
 * last message); a due date with no year is read around that day, not around today.
 */
export function dueLabel(
  dueDate: string | null,
  now: Date,
  timeZone: string,
  writtenAt: Date | null = null,
): { daysPastDue: number | null; text: string } {
  if (!dueDate) return { daysPastDue: null, text: "No due date" };
  const today = localDate(now, timeZone);
  const todayN = dayNumber(today);
  if (todayN === null) return { daysPastDue: null, text: "No due date" };
  const written =
    writtenAt && writtenAt.getTime() < now.getTime() ? localDate(writtenAt, timeZone) : today;
  const writtenN = dayNumber(written) ?? todayN;
  const due = dueDay(dueDate, writtenN, Number(written.slice(0, 4)));
  if (due === null) return { daysPastDue: null, text: "No due date" };
  const late = todayN - due;
  if (late < 0) return { daysPastDue: late, text: "Not due yet" };
  if (late === 0) return { daysPastDue: 0, text: "Due today" };
  return { daysPastDue: late, text: `${late} day${late === 1 ? "" : "s"} past due` };
}

/**
 * Oldest due first: the most days past due on top, then the ones due soonest, then the
 * ones with no due date, oldest conversation first.
 */
export function sortOwed<
  T extends { due: { daysPastDue: number | null }; lastMessageAt: Date | null },
>(rows: T[]): T[] {
  const time = (d: Date | null) => d?.getTime() ?? 0;
  return [...rows].sort((a, b) => {
    const da = a.due.daysPastDue;
    const db = b.due.daysPastDue;
    if (da !== null && db !== null) return db - da || time(a.lastMessageAt) - time(b.lastMessageAt);
    if (da !== null) return -1;
    if (db !== null) return 1;
    return time(a.lastMessageAt) - time(b.lastMessageAt);
  });
}

/**
 * Which open invoice a payment receipt is for: the ONE whose invoice number matches
 * (however it's written). No number on the receipt → no match — an amount alone could be
 * the owner's own purchase (A12). Two open invoices with that number → no match. When
 * both say how much, the amounts must agree to the cent: QuickBooks numbers every
 * company's invoices from 1001, so the receipt for the owner's own supplier bill 1037 can
 * share a number with the owner's invoice 1037.
 */
export function matchReceipt(
  receipt: InvoiceFacts,
  open: { threadId: string; invoice: InvoiceFacts | null }[],
): string | null {
  const n = normalizeInvoiceNumber(receipt.invoice_number);
  if (!n) return null;
  const hits = open.filter((o) => normalizeInvoiceNumber(o.invoice?.invoice_number) === n);
  if (hits.length !== 1) return null;
  const theirs = hits[0]!.invoice?.amount;
  if (receipt.amount && theirs && toCents(receipt.amount) !== toCents(theirs)) return null;
  return hits[0]!.threadId;
}

/**
 * The email names a different invoice from the one on the thread, still to be paid
 * ("invoice #42 for phase 2" after #41 was paid). Any paid / not-owed mark was about the
 * earlier invoice, so it no longer applies.
 */
export function isNewInvoice(prev: InvoiceFacts | null, next: InvoiceFacts | null): boolean {
  if (!prev || !next) return false;
  if (next.status !== "unpaid" && next.status !== "partly_paid") return false;
  const a = normalizeInvoiceNumber(prev.invoice_number);
  const b = normalizeInvoiceNumber(next.invoice_number);
  return a !== null && b !== null && a !== b;
}

/**
 * Whether this email takes OUR paid guess off the thread (an 'auto' mark only — the owner's
 * marks follow `isNewInvoice`, and "Not owed to me" is never cleared). It does when the email
 * says money is still owed, with an amount, and that is not simply the invoice we guessed was
 * paid: a different number, an earlier invoice with no number ("Sent the $900 deposit", then
 * "Got invoice #1043 for $3,000"), or a different amount.
 */
export function clearsAutoPaid(prev: InvoiceFacts | null, next: InvoiceFacts | null): boolean {
  if (!next) return false;
  if (next.status !== "unpaid" && next.status !== "partly_paid") return false;
  if (!(next.amount && next.amount > 0)) return false;
  if (!prev) return true;
  if (isNewInvoice(prev, next)) return true;
  if (normalizeInvoiceNumber(prev.invoice_number) === null) return true;
  return !prev.amount || toCents(prev.amount) !== toCents(next.amount);
}

/**
 * The current invoice is paid but earlier ones on the thread are still open: the oldest
 * open one becomes the current invoice (still to be paid), so the thread stays owed and is
 * never marked paid while money is left (only the paid one drops off). Anything else is
 * returned unchanged.
 */
export function promoteEarlierOpen(invoice: InvoiceFacts | null): InvoiceFacts | null {
  if (!invoice || invoice.status !== "paid") return invoice;
  const [oldest, ...rest] = invoice.earlier_open ?? [];
  if (!oldest) return invoice;
  return {
    invoice_number: oldest.invoice_number,
    amount: oldest.amount,
    due_date: null,
    status: "unpaid",
    ...(rest.length ? { earlier_open: rest } : {}),
  };
}

/**
 * Every classification replaces the thread's facts, so a "paid, thanks" (no amount) or a
 * "use the side gate" (no invoice at all) would drop the amount and the row with it (A11).
 * Keeps the earlier invoice when the new email has none, and fills the gaps when it's the
 * same invoice (same number, or no number). A different number is a new invoice; if the
 * earlier one was still owed (`prevOwed`, which the caller works out from the paid marks),
 * it is kept in `earlier_open` so it never silently drops off the total.
 */
export function carryInvoiceFacts(
  prev: InvoiceFacts | null,
  next: InvoiceFacts | null,
  prevOwed: boolean = prev?.status === "unpaid" || prev?.status === "partly_paid",
): InvoiceFacts | null {
  if (!prev) return next;
  if (!next) return prev;
  const a = normalizeInvoiceNumber(prev.invoice_number);
  const b = normalizeInvoiceNumber(next.invoice_number);
  const earlier = prev.earlier_open ?? [];
  // "Paid #41" while #42 is the current one: #41 is settled, #42 is still owed.
  if (
    b &&
    next.status === "paid" &&
    earlier.some((e) => normalizeInvoiceNumber(e.invoice_number) === b)
  ) {
    const left = earlier.filter((e) => normalizeInvoiceNumber(e.invoice_number) !== b);
    return promoteEarlierOpen({
      invoice_number: prev.invoice_number,
      amount: prev.amount,
      due_date: prev.due_date,
      status: prev.status,
      ...(left.length ? { earlier_open: left } : {}),
    });
  }
  if (a && b && a !== b) {
    const stillOpen = [
      ...(prevOwed ? earlier : []),
      ...(prevOwed && prev.amount
        ? [{ invoice_number: prev.invoice_number, amount: prev.amount }]
        : []),
    ].filter((e) => normalizeInvoiceNumber(e.invoice_number) !== b);
    return promoteEarlierOpen({
      invoice_number: next.invoice_number,
      amount: next.amount,
      due_date: next.due_date,
      status: next.status,
      ...(stillOpen.length ? { earlier_open: stillOpen.slice(-MAX_EARLIER_OPEN) } : {}),
    });
  }
  // "Paid invoice 42" while #41 is still open: #42 is settled and #41 becomes the current
  // invoice (promoteEarlierOpen), so the thread is never marked paid with money left.
  return promoteEarlierOpen({
    invoice_number: next.invoice_number ?? prev.invoice_number,
    amount: next.amount ?? prev.amount,
    due_date: next.due_date ?? prev.due_date,
    // "Can you resend invoice 42?" doesn't say whether it's paid: the earlier word stands.
    status: next.status === "unknown" ? prev.status : next.status,
    ...(earlier.length ? { earlier_open: earlier } : {}),
  });
}

/**
 * What the newest customer email said about paying, in its own words (`extracted.payment_said`,
 * set at classification and never carried over). Null when it said nothing of the kind.
 */
export function paymentSaid(extracted: unknown): "paid" | "partly_paid" | null {
  const v = (extracted as { payment_said?: unknown } | null | undefined)?.payment_said;
  return v === "paid" || v === "partly_paid" ? v : null;
}

/** Added to a waiting nudge when we think the invoice was paid (a guess never deletes it, A8). */
export const PAID_GUESS_FLAG = "We think this was paid — check before sending.";
/** The note on a waiting nudge closed because the owner marked the invoice paid (or not owed). */
export const PAID_NOTE = "Marked paid, so this nudge was dropped.";
export const NOT_OWED_NOTE = "You said this isn't owed to you, so this nudge was dropped.";

/**
 * Check 12 P1: what the Money owed card says about chasing, in one honest line. "Nudges used:
 * 0 of 2" read as "a nudge is coming" even when none ever would. `needsYou` is "manual" for
 * the owner's own "This one needs me", "other" for any other needs-you reason that stops a nudge
 * (a dispute, say; an invoice that needs the owner only for its size is still chased).
 */
export type ChaseFacts = {
  followupsOn: boolean;
  nudgesUsed: number;
  needsYou: "manual" | "other" | null;
  /** The customer wrote last: the owner owes them an answer, so we don't nudge. */
  waitingOnOwner: boolean;
  /** The owner last wrote longer ago than nudges are ever drafted for. */
  quietTooLong: boolean;
};

export function chaseLine(row: ChaseFacts, maxNudges = 2): string {
  if (!row.followupsOn) return "Not chased: follow-ups are off in Settings";
  if (row.nudgesUsed >= maxNudges) return "Both reminders used. Chasing is up to you now.";
  if (row.needsYou === "manual") return "Not chased: you marked this one as needing you";
  if (row.needsYou === "other") return "Not chased: this one needs you first";
  if (row.waitingOnOwner) return "Not chased while they're waiting on your reply";
  if (row.quietTooLong) return "Not chased: it's been quiet too long. Chasing is up to you now.";
  return `We'll draft a reminder if they go quiet (${Math.max(0, row.nudgesUsed)} of ${maxNudges} used)`;
}
