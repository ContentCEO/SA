import "server-only";
import { and, desc, eq, inArray, max, ne, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, messages, threads } from "@/db/schema";
import { listQuotes, type QuoteRow } from "./quotes";

export type CustomerRow = {
  /** Opaque link key (their newest message's id) — keeps email addresses out of URLs and logs. */
  key: string;
  address: string;
  name: string | null;
  conversations: number;
  lastContactAt: Date | null;
  openQuotes: number;
  wonCents: number;
  isSupplier: boolean;
};

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);
const notNoise = or(isNull(threads.category), ne(threads.category, "noise"));

/**
 * Everyone who has written to the owner's business inbox (noise left out),
 * built from mail we've already synced — nothing for the owner to type.
 */
export async function listCustomers(workspaceId: string, now: Date = new Date()) {
  const addr = sql<string>`lower(${messages.fromAddress})`;
  const rows = await db()
    .select({
      address: addr,
      key: sql<string>`(array_agg(${messages.id}::text order by ${messages.sentAt} desc))[1]`,
      name: sql<string | null>`max(${messages.fromName})`,
      conversations: sql<number>`count(distinct ${messages.threadId})::int`,
      lastContactAt: max(threads.lastMessageAt),
      supplierThreads: sql<number>`count(distinct ${messages.threadId}) filter (where ${threads.category} = 'supplier_vendor')`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
        eq(threads.inInbox, true),
        sql`${messages.fromAddress} is not null`,
        notNoise,
      ),
    )
    .groupBy(addr)
    .orderBy(desc(max(threads.lastMessageAt)))
    .limit(500);

  const { quotes } = await listQuotes(workspaceId, now);
  const byCustomer = new Map<string, QuoteRow[]>();
  for (const q of quotes) {
    if (!q.customerAddress) continue;
    byCustomer.set(q.customerAddress, [...(byCustomer.get(q.customerAddress) ?? []), q]);
  }

  return rows.map<CustomerRow>((r) => {
    const qs = byCustomer.get(r.address) ?? [];
    return {
      key: r.key,
      address: r.address,
      name: r.name,
      conversations: Number(r.conversations),
      lastContactAt: asDate(r.lastContactAt),
      openQuotes: qs.filter((q) => q.stage !== "won" && q.stage !== "lost").length,
      wonCents: qs.filter((q) => q.stage === "won").reduce((t, q) => t + (q.amountCents ?? 0), 0),
      isSupplier:
        Number(r.supplierThreads) > 0 && Number(r.supplierThreads) === Number(r.conversations),
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
  const [m] = await db()
    .select({ address: messages.fromAddress })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(messages.id, key),
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
      ),
    );
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
        sql`lower(${messages.fromAddress}) = ${email}`,
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
    .select({ name: messages.fromName })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        sql`lower(${messages.fromAddress}) = ${email}`,
        sql`${messages.fromName} is not null`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return { address: email, name: named?.name ?? null, threads: list satisfies CustomerThread[] };
}
