import "server-only";
import { and, count, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { notDraftMessage } from "./thread-sql";

/**
 * The owner has written to this address from this mailbox before `before` (their own sent
 * mail, as synced; addresses are stored lowercased). Autopilot's layer-3 rule, and a review
 * request's (A2): we only ever ask someone the owner already talks to. A message still labelled
 * DRAFT never counts: it hasn't been sent.
 */
export async function knownCustomer(
  mailboxId: string,
  address: string | null,
  before: Date,
): Promise<boolean> {
  if (!address) return false;
  const [row] = await db()
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "out"),
        // An unsent Gmail draft (ours or the owner's) is not writing to them.
        notDraftMessage(),
        lt(messages.sentAt, before),
        sql`${messages.toAddresses} @> ${JSON.stringify([address.toLowerCase()])}::jsonb`,
      ),
    );
  return (row?.n ?? 0) > 0;
}
