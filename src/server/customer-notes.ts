import "server-only";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerNotes, mailboxes, messages, workspaces } from "@/db/schema";
import { effectiveStatus, jobsAllowed, ReadOnlyError } from "./lifecycle";
import { keyFromMessage, normalizePattern, type KeyRefusal } from "./owner-sender-rule-rules";
import { ruleSource } from "./sender-rule-store";
import { replyAddressSql, sideEmailSql } from "./thread-sql";

/**
 * Ideas G7: the owner's private note about a customer. Only the owner sees it: it is never
 * sent to a customer or to the AI, and never goes in an alert, a morning email, admin or a
 * log. Keyed on the customer's reply address; goes with the Gmail address it was written under.
 * A static test lists the only files that may read it.
 */
export const NOTE_MAX_CHARS = 200;
export const MAX_NOTES = 1_000;

export type NoteRefusal = KeyRefusal | "empty" | "too_long" | "full" | "not_found";

export const NOTE_REFUSALS: Record<NoteRefusal, string> = {
  unchecked: "We're still checking where this customer's email came from. Try again later.",
  platform:
    "This email came through a lead site, so a note here would show on many customers' emails.",
  robot: "This email came from an automatic address.",
  empty: "Write a short note first.",
  too_long: `Keep it under ${NOTE_MAX_CHARS} characters.`,
  full: "You have a lot of notes. Remove one first.",
  not_found: "That customer isn't here any more. Refresh and try again.",
};

/** The note for one customer address, or null. */
export async function noteFor(workspaceId: string, address: string) {
  const [n] = await db()
    .select({ body: customerNotes.body })
    .from(customerNotes)
    .where(
      and(
        eq(customerNotes.workspaceId, workspaceId),
        eq(customerNotes.address, normalizePattern(address)),
      ),
    );
  return n?.body ?? null;
}

/** Notes by address, for queue cards (keyed on the address the reply goes to). */
export async function notesForAddresses(
  workspaceId: string,
  addresses: readonly (string | null)[],
): Promise<Map<string, string>> {
  const list = [...new Set(addresses.filter((a): a is string => !!a).map(normalizePattern))];
  if (!list.length) return new Map();
  const rows = await db()
    .select({ address: customerNotes.address, body: customerNotes.body })
    .from(customerNotes)
    .where(and(eq(customerNotes.workspaceId, workspaceId), inArray(customerNotes.address, list)));
  return new Map(rows.map((r) => [r.address, r.body]));
}

/**
 * Notes by thread for Inbox rows: the customer is the newest email in that isn't a side
 * conversation (a crew member's reply to a forward never decides whose note shows). Also the
 * id of that email: the opaque key the customer page and the note's Edit link use.
 */
export async function notesForThreads(
  workspaceId: string,
  threadIds: readonly string[],
): Promise<Map<string, { note: string | null; key: string; address: string | null }>> {
  if (!threadIds.length) return new Map();
  const rows = await db()
    .select({
      threadId: messages.threadId,
      key: messages.id,
      address: sql<string | null>`${replyAddressSql("messages")}`,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(messages.threadId, [...threadIds]),
        eq(messages.direction, "in"),
        sql`not ${sideEmailSql("messages")}`,
        sql`${messages.sentAt} = (select max(n.sent_at) from messages n where n.thread_id = ${messages.threadId} and n.direction = 'in' and not ${sideEmailSql("n")})`,
      ),
    );
  const notes = await notesForAddresses(
    workspaceId,
    rows.map((r) => r.address),
  );
  const out = new Map<string, { note: string | null; key: string; address: string | null }>();
  for (const r of rows)
    if (!out.has(r.threadId))
      out.set(r.threadId, {
        key: r.key,
        address: r.address,
        note: r.address ? (notes.get(r.address) ?? null) : null,
      });
  return out;
}

async function writable(workspaceId: string, now: Date) {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) return false;
  if (!jobsAllowed(ws, now)) throw new ReadOnlyError(effectiveStatus(ws, now));
  return true;
}

/**
 * Save (or replace) the note for the customer of one email (the opaque key: a message id).
 * The email must give a real customer address (§ keyFromMessage).
 */
export async function saveNote(
  workspaceId: string,
  messageId: string,
  body: string,
  now: Date = new Date(),
): Promise<"saved" | NoteRefusal> {
  if (!(await writable(workspaceId, now))) return "not_found";
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return "empty";
  if (text.length > NOTE_MAX_CHARS) return "too_long";
  const m = await ruleSource(workspaceId, messageId);
  if (!m) return "not_found";
  const key = keyFromMessage(m);
  if (!key.ok) return key.why;
  const [existing] = await db()
    .select({ id: customerNotes.id })
    .from(customerNotes)
    .where(and(eq(customerNotes.workspaceId, workspaceId), eq(customerNotes.address, key.key)));
  if (!existing) {
    const [{ n } = { n: 0 }] = await db()
      .select({ n: count() })
      .from(customerNotes)
      .where(eq(customerNotes.workspaceId, workspaceId));
    if (n >= MAX_NOTES) return "full";
  }
  await db()
    .insert(customerNotes)
    .values({ workspaceId, mailboxId: m.mailboxId, address: key.key, body: text, updatedAt: now })
    .onConflictDoUpdate({
      target: [customerNotes.workspaceId, customerNotes.address],
      set: { body: text, updatedAt: now },
    });
  return "saved";
}

export async function removeNote(
  workspaceId: string,
  messageId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!(await writable(workspaceId, now))) return false;
  const m = await ruleSource(workspaceId, messageId);
  if (!m) return false;
  const key = keyFromMessage(m);
  if (!key.ok) return false;
  const gone = await db()
    .delete(customerNotes)
    .where(and(eq(customerNotes.workspaceId, workspaceId), eq(customerNotes.address, key.key)))
    .returning({ id: customerNotes.id });
  return gone.length > 0;
}
