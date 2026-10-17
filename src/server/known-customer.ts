import "server-only";
import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { drafts, mailboxes, messages } from "@/db/schema";
import { notDraftMessage, sideEmailSql } from "./thread-sql";

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

/**
 * Replies package (draft.v7): the owner has written to this customer before — on any thread,
 * from any of the workspace's mailboxes — or on this conversation at all. The same "owner
 * wrote" as `knownCustomer` (their own sent mail as synced; an unsent Gmail draft never
 * counts), widened to every mailbox and to a reply sent from the app that sync hasn't stored
 * yet, and narrowed by `sideEmailSql`: a forward to the crew isn't writing to the customer.
 * `addresses` are the customer's (their reply address); lowercased here.
 * False means a first contact.
 */
export async function ownerWroteBefore(p: {
  workspaceId: string;
  threadId: string;
  addresses: (string | null | undefined)[];
  before: Date;
}): Promise<boolean> {
  const addrs = [
    ...new Set(p.addresses.filter((a): a is string => !!a).map((a) => a.trim().toLowerCase())),
  ];
  const boxes = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, p.workspaceId))
  ).map((b) => b.id);
  if (!boxes.length) return false;
  const anyAddress = addrs.length
    ? sql`(${sql.join(
        addrs.map((a) => sql`${messages.toAddresses} @> ${JSON.stringify([a])}::jsonb`),
        sql` or `,
      )})`
    : sql`false`;
  const [mail] = await db()
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        inArray(messages.mailboxId, boxes),
        eq(messages.direction, "out"),
        notDraftMessage(),
        sql`not ${sideEmailSql("messages")}`,
        lt(messages.sentAt, p.before),
        sql`(${messages.threadId} = ${p.threadId} or ${anyAddress})`,
      ),
    );
  if ((mail?.n ?? 0) > 0) return true;
  // A reply sent (or being sent) from the app, before sync stored it.
  const [sent] = await db()
    .select({ n: count() })
    .from(drafts)
    .where(
      and(
        inArray(drafts.mailboxId, boxes),
        sql`(${drafts.status} in ('sent', 'edited_and_sent') or (${drafts.status} = 'pending' and (${drafts.sendAfter} is not null or ${drafts.sendClaimedAt} is not null)))`,
        addrs.length
          ? sql`(${drafts.threadId} = ${p.threadId} or lower(${drafts.toAddress}) in (${sql.join(
              addrs.map((a) => sql`${a}`),
              sql`, `,
            )}))`
          : eq(drafts.threadId, p.threadId),
      ),
    );
  return (sent?.n ?? 0) > 0;
}
