import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, priceHistory, threads } from "@/db/schema";
import { priceMemoryLabel, similarPrices, type PastPrice } from "./price-memory-rules";

/**
 * Plan #15 price memory, read side. OWNER-ONLY: imported by the Queue and Inbox
 * pages and nothing else — never by the drafter, classifier, digest, admin, push
 * or text alerts (a static test holds that line). The figures go to the owner's
 * screen; a tap fills a {{price}} gap in the browser, and only then does a price
 * reach a draft.
 */

/** How far back we look: the newest quotes are the ones that matter. */
const HISTORY_ROWS = 500;

export type PriceMemoryItem = { cents: number; value: string; month: string };

/** Past prices for each item's kind of job, from one read of the workspace's price memory. */
export async function similarPricesFor(
  workspaceId: string,
  items: { threadId: string; service: string | null }[],
): Promise<Map<string, { amountCents: number; quotedAt: Date }[]>> {
  const out = new Map<string, { amountCents: number; quotedAt: Date }[]>();
  const wanted = items.filter((i) => i.service?.trim());
  if (!wanted.length) return out;
  const history: PastPrice[] = await db()
    .select({
      service: priceHistory.service,
      amountCents: priceHistory.amountCents,
      quotedAt: priceHistory.quotedAt,
      threadId: priceHistory.threadId,
    })
    .from(priceHistory)
    .where(eq(priceHistory.workspaceId, workspaceId))
    .orderBy(desc(priceHistory.quotedAt))
    .limit(HISTORY_ROWS);
  if (!history.length) return out;
  for (const i of wanted) {
    const found = similarPrices(i.service!, history, { excludeThreadId: i.threadId });
    if (found.length) out.set(i.threadId, found);
  }
  return out;
}

/** The kind of job sorting found on each thread (scoped to the workspace). */
async function servicesFor(workspaceId: string, threadIds: string[]) {
  if (!threadIds.length) return [];
  return db()
    .select({
      threadId: threads.id,
      service: sql<string | null>`${threads.extracted}->>'service_requested'`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), inArray(threads.id, threadIds)));
}

/**
 * What the owner's screen shows for each quote-request thread: up to three past
 * prices for similar jobs, as "$1,800" + "Mar" in their time zone.
 */
export async function priceMemoryFor(
  workspaceId: string,
  threadIds: string[],
  opts: { timeZone: string; now?: Date },
): Promise<Map<string, PriceMemoryItem[]>> {
  const ids = [...new Set(threadIds)];
  const services = await servicesFor(workspaceId, ids);
  const found = await similarPricesFor(
    workspaceId,
    services.map((s) => ({
      threadId: s.threadId,
      service: typeof s.service === "string" ? s.service : null,
    })),
  );
  const out = new Map<string, PriceMemoryItem[]>();
  for (const [threadId, prices] of found) {
    out.set(
      threadId,
      prices.map((p) => ({
        cents: p.amountCents,
        ...priceMemoryLabel(p, opts.timeZone, opts.now),
      })),
    );
  }
  return out;
}
