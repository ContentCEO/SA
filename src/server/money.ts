import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { expirePendingNudge, flagPendingNudge, unflagPendingNudge, type DraftDeps } from "./drafts";
import { effectiveStatus, jobsAllowed, ReadOnlyError } from "./lifecycle";
import { customerAddressSql, customerNameSql } from "./thread-sql";
import {
  dueLabel,
  invoiceOf,
  isOwed,
  isReceiptSender,
  NOT_OWED_NOTE,
  owedCents,
  PAID_GUESS_FLAG,
  PAID_NOTE,
  promoteEarlierOpen,
  sortOwed,
  toCents,
  type InvoiceFacts,
} from "./money-rules";

export type MoneyRow = {
  threadId: string;
  gmailThreadId: string;
  mailboxEmail: string;
  customerName: string | null;
  customerAddress: string | null;
  /** Null when the email never said how much (a paid / hidden row, or one the owner put back). */
  amountCents: number | null;
  invoiceNumber: string | null;
  /** Earlier invoices on the thread still owed when this one arrived (counted in the total). */
  earlierOpen: { invoiceNumber: string | null; amountCents: number }[];
  due: { daysPastDue: number | null; text: string };
  /** Follow-up nudges sent on the thread (threads.followup_count), out of two. */
  nudgesUsed: number;
  paidAt: Date | null;
  paidSource: "owner" | "auto" | "not_owed" | null;
  lastMessageAt: Date | null;
};

const DAY_MS = 86_400_000;
/** Paid rows stay on the screen this long, so a wrong mark can be undone. */
export const PAID_SHOWN_DAYS = 30;
const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);

/**
 * Every thread that can be on the money screen: about an invoice (now or before), or marked
 * paid / hidden at some point, in this workspace. Never a supplier's bill (supplier_vendor,
 * A2). Receipt senders are dropped in code (`isReceiptSender`), since their own thread is
 * never a customer's invoice.
 *
 * Narrowed in SQL to rows that can show (a superset of what `isOwed` / the paid and hidden
 * lists keep), so old paid invoices and "paid" emails never push an old, still-owed one
 * past the cap. `openOnly` keeps just the unmarked or put-back ones (receipt matching).
 */
async function moneyThreads(workspaceId: string, now: Date, opts: { openOnly?: boolean } = {}) {
  const shownSince = new Date(now.getTime() - PAID_SHOWN_DAYS * DAY_MS);
  const unmarkedOwed = and(
    isNull(threads.invoicePaidAt),
    isNull(threads.invoicePaidSource),
    // SQL twin of `holdsOwedInvoice` (a superset): the current invoice is owed with an
    // amount, or an earlier one on the thread is still open, amount or not on the current.
    or(
      and(
        sql`${threads.extracted}->'invoice'->>'status' in ('unpaid', 'partly_paid')`,
        sql`${threads.extracted}->'invoice'->>'amount' is not null`,
      ),
      sql`${threads.extracted}->'invoice'->'earlier_open' is not null`,
    ),
  );
  const putBack = and(isNull(threads.invoicePaidAt), eq(threads.invoicePaidSource, "owner"));
  const canShow = opts.openOnly
    ? or(unmarkedOwed, putBack)
    : or(
        unmarkedOwed,
        putBack,
        eq(threads.invoicePaidSource, "not_owed"),
        and(
          inArray(threads.invoicePaidSource, ["owner", "auto"]),
          gte(threads.invoicePaidAt, shownSince),
        ),
      );
  const rows = await db()
    .select({
      threadId: threads.id,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
      extracted: threads.extracted,
      paidAt: threads.invoicePaidAt,
      paidSource: threads.invoicePaidSource,
      followupCount: threads.followupCount,
      lastMessageAt: threads.lastMessageAt,
      // As a reply addresses them (a form's Reply-To, else From); the sender is for the
      // receipt check (a receipt's Reply-To is the merchant).
      customerName: customerNameSql(),
      customerAddress: customerAddressSql(),
      senderAddress: sql<
        string | null
      >`(select lower(m.from_address) from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        // SQL twin of `isInvoiceThread`, plus anything ever marked paid / hidden.
        or(
          eq(threads.category, "invoice_payment"),
          sql`${threads.extracted}->>'invoice_thread' = 'true'`,
          isNotNull(threads.invoicePaidSource),
        ),
        sql`${threads.category} is distinct from 'supplier_vendor'`,
        // A bill the owner has to pay (a supplier's statement sorted as an invoice) is never
        // money owed TO them (round 2, TW A2).
        sql`(${threads.extracted}->>'bill_direction') is distinct from 'owed_by_business'`,
        canShow,
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    // A defensive cap only: after the filter above, a 1–15 person shop has far fewer.
    .limit(2000);
  return rows
    .filter((r) => !isReceiptSender(r.senderAddress) && !isReceiptSender(r.customerAddress))
    .map((r) => {
      const { senderAddress, ...row } = r;
      void senderAddress;
      return { ...row, invoice: invoiceOf(row.extracted) };
    });
}

function toRow(
  r: Awaited<ReturnType<typeof moneyThreads>>[number],
  now: Date,
  timeZone: string,
): MoneyRow {
  const invoice: InvoiceFacts | null = r.invoice;
  return {
    threadId: r.threadId,
    gmailThreadId: r.gmailThreadId,
    mailboxEmail: r.mailboxEmail,
    customerName: r.customerName,
    customerAddress: r.customerAddress,
    amountCents: invoice?.amount ? toCents(invoice.amount) : null,
    invoiceNumber: invoice?.invoice_number ?? null,
    earlierOpen: (invoice?.earlier_open ?? []).map((e) => ({
      invoiceNumber: e.invoice_number,
      amountCents: toCents(e.amount ?? 0),
    })),
    // A due date with no year is read around when the email was written, not today.
    due: dueLabel(invoice?.due_date ?? null, now, timeZone, asDate(r.lastMessageAt)),
    nudgesUsed: r.followupCount,
    paidAt: asDate(r.paidAt),
    paidSource: r.paidSource ?? null,
    lastMessageAt: asDate(r.lastMessageAt),
  };
}

/**
 * The money screen: what's still owed (oldest due first), what was marked paid in the last
 * 30 days (so a wrong mark can be undone), and what the owner hid as "Not owed to me".
 */
export async function listMoney(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{
  owed: MoneyRow[];
  paidRecently: MoneyRow[];
  hidden: MoneyRow[];
  totalOwedCents: number;
}> {
  const [profile] = await db()
    .select({ timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const tz = profile?.timeZone ?? "America/New_York";
  const rows = await moneyThreads(workspaceId, now);

  const owedRows = rows.filter((r) =>
    isOwed({ invoice: r.invoice, paidAt: asDate(r.paidAt), paidSource: r.paidSource }),
  );
  const owed = sortOwed(owedRows.map((r) => toRow(r, now, tz)));
  const paidRecently = rows
    .filter(
      (r) =>
        r.paidAt &&
        (r.paidSource === "owner" || r.paidSource === "auto") &&
        now.getTime() - asDate(r.paidAt)!.getTime() <= PAID_SHOWN_DAYS * DAY_MS,
    )
    .map((r) => toRow(r, now, tz))
    .sort((a, b) => b.paidAt!.getTime() - a.paidAt!.getTime());
  const hidden = rows.filter((r) => r.paidSource === "not_owed").map((r) => toRow(r, now, tz));
  return {
    owed,
    paidRecently,
    hidden,
    totalOwedCents: owedRows.reduce((t, r) => t + owedCents(r.invoice), 0),
  };
}

/** Open invoices a payment receipt could be for (never the receipt's own thread). */
export async function openInvoices(
  workspaceId: string,
  exceptThreadId: string,
  now: Date = new Date(),
) {
  const rows = await moneyThreads(workspaceId, now, { openOnly: true });
  return rows
    .filter(
      (r) =>
        r.threadId !== exceptThreadId &&
        isOwed({ invoice: r.invoice, paidAt: asDate(r.paidAt), paidSource: r.paidSource }),
    )
    .map((r) => ({ threadId: r.threadId, invoice: r.invoice }));
}

async function ownedThread(workspaceId: string, threadId: string) {
  const [t] = await db()
    .select({ id: threads.id, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  return t;
}

/**
 * The owner's "Mark paid" (paid = true) or "Undo" / "Put back" (paid = false). Scoped to
 * their workspace (false otherwise); read-only accounts get ReadOnlyError. Always recorded
 * as the owner's, so our guesses never touch this invoice again — an undo keeps it owed
 * even if the email says paid. Marking paid drops a waiting nudge, here and in Gmail; the
 * mark stands even if Gmail can't be reached.
 */
export async function setInvoicePaid(
  workspaceId: string,
  threadId: string,
  paid: boolean,
  now: Date = new Date(),
  opts: Pick<DraftDeps, "writerFor"> = {},
): Promise<boolean> {
  return ownerMark(workspaceId, threadId, paid ? "paid" : "owed", now, opts);
}

/** The owner's "Not owed to me": hidden from both lists, never chased. Undo with setInvoicePaid(false). */
export async function setInvoiceNotOwed(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
  opts: Pick<DraftDeps, "writerFor"> = {},
): Promise<boolean> {
  return ownerMark(workspaceId, threadId, "not_owed", now, opts);
}

async function ownerMark(
  workspaceId: string,
  threadId: string,
  mark: "paid" | "owed" | "not_owed",
  now: Date,
  opts: Pick<DraftDeps, "writerFor">,
): Promise<boolean> {
  const t = await ownedThread(workspaceId, threadId);
  if (!t) return false;
  if (!jobsAllowed(t.workspace, now)) throw new ReadOnlyError(effectiveStatus(t.workspace, now));
  // Only a real change is written and logged: a double tap (or a resent form) neither
  // repeats the Activity line nor restarts the 30-day Undo window.
  const changes = {
    // Parenthesised: drizzle's and() doesn't wrap its parts, and a bare `or` would match
    // every other thread.
    paid: sql`(${threads.invoicePaidAt} is null or ${threads.invoicePaidSource} is distinct from 'owner')`,
    owed: sql`(${threads.invoicePaidAt} is not null or ${threads.invoicePaidSource} is distinct from 'owner')`,
    not_owed: sql`${threads.invoicePaidSource} is distinct from 'not_owed'`,
  }[mark];
  const changed = await db()
    .update(threads)
    .set({
      invoicePaidAt: mark === "owed" ? null : now,
      invoicePaidSource: mark === "not_owed" ? "not_owed" : "owner",
    })
    .where(and(eq(threads.id, threadId), changes))
    .returning({ id: threads.id });
  if (changed.length > 0) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId,
        actor: "owner",
        action:
          mark === "paid"
            ? "invoice_marked_paid"
            : mark === "owed"
              ? "invoice_marked_unpaid"
              : "invoice_marked_not_owed",
        threadId,
        detail: { source: "owner" },
      });
  }
  if (mark === "owed") {
    // The owner just said it isn't paid: a waiting nudge no longer says we think it was.
    await unflagPendingNudge(threadId, PAID_GUESS_FLAG);
  } else {
    // Written before we look for a waiting nudge, so a nudge being written right now either
    // is found here or sees the mark when it re-checks (createDraftForThread).
    try {
      await expirePendingNudge(threadId, mark === "paid" ? PAID_NOTE : NOT_OWED_NOTE, {
        ...opts,
        now: () => now,
      });
    } catch (err) {
      console.error("invoice_nudge_expire_failed", {
        workspaceId,
        threadId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return true;
}

/**
 * A payment receipt for the thread's current invoice. While earlier invoices on the thread
 * are still open, the thread is not paid: the oldest open one becomes the current invoice
 * (`promoteEarlierOpen`) and nothing is marked. Otherwise it is our paid guess
 * (`autoMarkInvoicePaid`). The facts are only rewritten while the thread is unmarked and
 * still holds the invoice the receipt matched.
 */
export async function settleByReceipt(
  threadId: string,
  invoice: InvoiceFacts | null,
  now: Date,
): Promise<boolean> {
  const promoted = promoteEarlierOpen(invoice ? { ...invoice, status: "paid" } : null);
  if (!invoice || !promoted || promoted.status === "paid") {
    return autoMarkInvoicePaid(threadId, "receipt", now);
  }
  const changed = await db()
    .update(threads)
    .set({
      extracted: sql`jsonb_set(coalesce(${threads.extracted}, '{}'::jsonb), '{invoice}', ${JSON.stringify(promoted)}::jsonb)`,
    })
    .where(
      and(
        eq(threads.id, threadId),
        isNull(threads.invoicePaidAt),
        sql`${threads.extracted}->'invoice'->>'invoice_number' is not distinct from ${invoice.invoice_number}::text`,
      ),
    )
    .returning({ id: threads.id });
  return changed.length > 0;
}

/**
 * Our guess that an invoice was paid: the customer said so on the thread ('reply'), or a
 * payment receipt named its invoice number ('receipt'). The owner always wins, in the UPDATE
 * itself: never over an owner's mark (paid, undo or not owed) and never twice — so a re-run
 * is a no-op and the activity row is written only when a row really changed (A14). A guess
 * never deletes anything: a waiting nudge stays, flagged for the owner to check, with any
 * autopilot countdown cleared (A8). Content-free log: the source and how we knew.
 */
export async function autoMarkInvoicePaid(
  threadId: string,
  via: "reply" | "receipt",
  now: Date,
): Promise<boolean> {
  const [row] = await db()
    .update(threads)
    .set({ invoicePaidAt: now, invoicePaidSource: "auto" })
    .where(
      and(
        eq(threads.id, threadId),
        sql`${threads.invoicePaidAt} is null`,
        sql`${threads.invoicePaidSource} is distinct from 'owner'`,
        sql`${threads.invoicePaidSource} is distinct from 'not_owed'`,
        sql`${threads.category} is distinct from 'supplier_vendor'`,
      ),
    )
    .returning({ mailboxId: threads.mailboxId });
  if (!row) return false;
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId));
  if (box) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId: box.workspaceId,
        actor: "squared_away",
        action: "invoice_marked_paid",
        threadId,
        detail: { source: "auto", via },
      });
  }
  await flagPendingNudge(threadId, PAID_GUESS_FLAG);
  return true;
}
