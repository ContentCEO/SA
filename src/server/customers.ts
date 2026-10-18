import "server-only";
import { and, desc, eq, inArray, max, ne, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, messages, threads } from "@/db/schema";
import { looksMunicipal } from "@/ai/guards";
import {
  crewSql,
  crewThreadSql,
  customerAddressSql,
  quoteThreadSql,
  messageReplyAddress,
  messageReplyName,
  customerRobotSql,
  sideEmailSql,
} from "./thread-sql";

/**
 * Check 13 P1: who someone is to the business. Customers are the default list; the other three
 * are kept apart under their own links.
 */
export const CUSTOMER_KINDS = ["customer", "supplier", "town", "crew"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

/**
 * Check 13 P1, pure: a building department or inspector (any of their mail looks municipal, or
 * a thread was marked so), then the owner's own people (crew list, own Gmail address or business
 * domain, or they only ever wrote as a side conversation — the crew's reply to a forward), then
 * a supplier (more than half of their conversations are supplier_vendor), else a customer.
 */
export function customerKind(r: {
  municipal: boolean;
  crew: boolean;
  onlySide: boolean;
  supplierThreads: number;
  conversations: number;
}): CustomerKind {
  if (r.municipal) return "town";
  if (r.crew || r.onlySide) return "crew";
  if (r.conversations > 0 && r.supplierThreads * 2 > r.conversations) return "supplier";
  return "customer";
}

export type CustomerRow = {
  /** Opaque link key (their newest message's id) — keeps email addresses out of URLs and logs. */
  key: string;
  address: string;
  name: string | null;
  conversations: number;
  lastContactAt: Date | null;
  openQuotes: number;
  wonCents: number;
  kind: CustomerKind;
};

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);
const notNoise = or(isNull(threads.category), ne(threads.category, "noise"));

/** Check 13 P3: the most rows Customers reads (a hard ceiling; only the count is logged). */
export const CUSTOMERS_CEILING = 10_000;

/**
 * Check 13 P3: quote facts per customer (the thread's reply address, as Quotes names them),
 * read-only: open quotes (a quote thread with no outcome) and won amounts. Never runs Quotes'
 * own amount capture or no-answer guesses, and has no cap on how many quotes it reads.
 */
async function quoteFactsByAddress(workspaceId: string) {
  const rows = await db()
    .select({
      address: customerAddressSql(),
      outcome: threads.quoteOutcome,
      amountCents: threads.quoteAmountCents,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        quoteThreadSql(),
        sql`not ${crewThreadSql(workspaceId)}`,
      ),
    );
  const out = new Map<string, { open: number; wonCents: number }>();
  for (const r of rows) {
    if (!r.address) continue;
    const f = out.get(r.address) ?? { open: 0, wonCents: 0 };
    if (r.outcome == null) f.open++;
    else if (r.outcome === "won") f.wonCents += r.amountCents ?? 0;
    out.set(r.address, f);
  }
  return out;
}

/**
 * The inbound emails Customers is built from (Check 13 P2: one rule for the list and for the
 * customer page, so a key that isn't on the list is a 404). Needs messages, threads and
 * mailboxes in the query.
 */
function listedMessage(workspaceId: string) {
  const addr = messageReplyAddress();
  return and(
    eq(mailboxes.workspaceId, workspaceId),
    eq(messages.direction, "in"),
    eq(threads.inInbox, true),
    sql`${messages.fromAddress} is not null`,
    // A robot is never a customer, or one portal or one website form shows up as one huge
    // customer (round 2 A9, Check 13 P2): a no-reply or job-board sender, a form robot with no
    // usable Reply-To, a lead platform's own address, a payment receipt.
    sql`not ${customerRobotSql(addr)}`,
    // Leads package: a lead website's or a phone service's sender isn't the customer.
    isNull(threads.leadChannel),
    notNoise,
  );
}

/**
 * Everyone who has written to the owner's business inbox (noise left out),
 * built from mail we've already synced — nothing for the owner to type. A customer is the
 * address a reply goes to: a website form's Reply-To, so two people who used the same form
 * are two customers, not one "form-submission@…".
 */
export async function listCustomers(workspaceId: string, now: Date = new Date()) {
  void now; // kept for callers; nothing here depends on the clock any more (Check 13 P3)
  const addr = messageReplyAddress();
  const rows = await db()
    .select({
      address: sql<string>`${addr}`,
      key: sql<string>`(array_agg(${messages.id}::text order by ${messages.sentAt} desc))[1]`,
      name: sql<string | null>`max(${messageReplyName()})`,
      conversations: sql<number>`count(distinct ${messages.threadId})::int`,
      lastContactAt: max(threads.lastMessageAt),
      supplierThreads: sql<number>`count(distinct ${messages.threadId}) filter (where ${threads.category} = 'supplier_vendor')`,
      // Check 13 P1: content-free flags for the kind. A sender pair list is read only for
      // `looksMunicipal` (the same check the sorter uses); it never leaves this function.
      municipalMark: sql<boolean>`coalesce(bool_or(${threads.extracted}->>'municipal' = 'true'), false)`,
      crew: sql<boolean>`coalesce(bool_or(${crewSql(workspaceId, addr)}), false)`,
      onlySide: sql<boolean>`coalesce(bool_and(${sideEmailSql("messages")}), false)`,
      senders: sql<
        string[] | null
      >`(array_agg(distinct coalesce(${messages.fromAddress}, '') || chr(1) || coalesce(${messages.fromName}, '')))[1:20]`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(listedMessage(workspaceId))
    .groupBy(addr)
    .orderBy(desc(max(threads.lastMessageAt)))
    // Check 13 P3: everyone, so search finds every customer; a hard ceiling only.
    .limit(CUSTOMERS_CEILING + 1);
  if (rows.length > CUSTOMERS_CEILING) {
    console.warn("customers_ceiling_hit", { workspaceId, count: rows.length });
    rows.length = CUSTOMERS_CEILING;
  }

  const facts = await quoteFactsByAddress(workspaceId);

  return rows.map<CustomerRow>((r) => {
    const q = facts.get(r.address);
    return {
      key: r.key,
      address: r.address,
      name: r.name,
      conversations: Number(r.conversations),
      lastContactAt: asDate(r.lastContactAt),
      openQuotes: q?.open ?? 0,
      wonCents: q?.wonCents ?? 0,
      kind: customerKind({
        municipal:
          !!r.municipalMark ||
          (r.senders ?? []).some((p) => {
            const [from, name] = p.split("\u0001");
            return looksMunicipal(from || null, name || null);
          }),
        crew: !!r.crew,
        onlySide: !!r.onlySide,
        supplierThreads: Number(r.supplierThreads),
        conversations: Number(r.conversations),
      }),
    };
  });
}

export type CustomerThread = {
  threadId: string;
  gmailThreadId: string;
  mailboxEmail: string;
  subject: string | null;
  summary: string | null;
  category: string | null;
  lastMessageAt: Date | null;
};

/** Look a customer up by the opaque key from `listCustomers`. Scoped to the workspace. */
export async function customerByKey(workspaceId: string, key: string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) return null;
  // Check 13 P2: only a key the list could have given out — an email that is itself on
  // Customers (not junk, not a robot, not a lead site's notice) — opens a page.
  const [m] = await db()
    .select({ address: messageReplyAddress() })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(eq(messages.id, key), listedMessage(workspaceId)));
  return m?.address ? customerDetail(workspaceId, m.address) : null;
}

/** One customer's conversations (they wrote in at least once). Scoped to the workspace. */
export async function customerDetail(workspaceId: string, address: string) {
  const email = address.trim().toLowerCase();
  const ids = await db()
    .selectDistinct({ id: messages.threadId })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
        sql`${messageReplyAddress()} = ${email}`,
      ),
    );
  if (!ids.length) return null;
  const list = await db()
    .select({
      threadId: threads.id,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
      subject: threads.subject,
      summary: threads.summary,
      category: threads.category,
      lastMessageAt: threads.lastMessageAt,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        inArray(
          threads.id,
          ids.map((i) => i.id),
        ),
        notNoise,
      ),
    )
    .orderBy(desc(threads.lastMessageAt));
  const [named] = await db()
    .select({ name: messageReplyName() })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
        sql`${messageReplyAddress()} = ${email}`,
        sql`${messageReplyName()} is not null`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return { address: email, name: named?.name ?? null, threads: list satisfies CustomerThread[] };
}
