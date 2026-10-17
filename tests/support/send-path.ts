import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "./db";
import { FakeWriter } from "./fake-writer";

/**
 * Wave 1 "Send path": a paid, sending account with one Gmail address, and a helper that seeds a
 * thread with one customer email and a pending draft that is also a Gmail draft in a FakeWriter.
 */
export const NOW = new Date("2026-10-10T16:00:00Z"); // noon in New York
export const READY_BODY = "Hi Dana,\nHappy to take a look. What's the address?\nThanks, Sam";
export const at = (s: number) => new Date(NOW.getTime() + s * 1000);

export type SeedOver = {
  category?: string;
  needsOwner?: boolean;
  needsOwnerReason?: string | null;
  extracted?: Record<string, unknown>;
  body?: string;
  flags?: string[];
  confidence?: number;
  kind?: "reply" | "followup";
  purpose?: "deposit" | "review_request" | "closing_question";
  draftCreatedAt?: Date;
};

export async function sendPathWorld() {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const database: Database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe" })
    .where(eq(workspaces.id, workspace.id));
  const mailbox = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  const writer = new FakeWriter();
  let n = 0;

  async function seed(over: SeedOver = {}) {
    const g = `t${++n}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId: mailbox.id,
        gmailThreadId: g,
        inInbox: true,
        subject: "Deck",
        category: (over.category ?? "quote_request") as "quote_request",
        needsOwner: over.needsOwner ?? false,
        needsOwnerReason: over.needsOwnerReason ?? null,
        priority: "normal",
        extracted: over.extracted ?? {},
        classifiedAt: NOW,
        lastMessageAt: new Date(NOW.getTime() - n * 60_000),
      })
      .returning();
    const [m] = await database
      .insert(messages)
      .values({
        threadId: t!.id,
        mailboxId: mailbox.id,
        gmailMessageId: `m-${g}`,
        rfc822MessageId: `<m-${g}@x.com>`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana",
        toAddresses: ["owner@shop.com"],
        subject: "Deck",
        bodyText: "Can you quote a deck repair?",
        sentAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    const body = over.body ?? READY_BODY;
    const gmail = await writer.createDraft({
      threadId: g,
      raw: Buffer.from(`To: dana@x.com\r\n\r\n${Buffer.from(body).toString("base64")}`).toString(
        "base64url",
      ),
    });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId: mailbox.id,
        gmailDraftId: gmail.draftId,
        replyToMessageId: m!.id,
        toAddress: "dana@x.com",
        subject: "Re: Deck",
        body,
        originalBody: body,
        reason: "Asked for the address.",
        flags: over.flags ?? [],
        confidence: over.confidence ?? 92,
        kind: over.kind ?? "reply",
        purpose: over.purpose ?? null,
        createdAt: over.draftCreatedAt ?? new Date(NOW.getTime() - 60_000),
      })
      .returning();
    writer.calls.length = 0;
    return { thread: t!, draft: d!, message: m! };
  }

  /** An email from the shop's address on the thread (someone answered from Gmail). */
  async function outbound(
    threadId: string,
    sentAt: Date,
    over: { to?: string[]; body?: string | null; gmailMessageId?: string } = {},
  ) {
    const [m] = await database
      .insert(messages)
      .values({
        threadId,
        mailboxId: mailbox.id,
        gmailMessageId: over.gmailMessageId ?? `out-${randomBytes(4).toString("hex")}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: over.to ?? ["dana@x.com"],
        subject: "Re: Deck",
        bodyText: over.body === undefined ? "Hi Dana, sure, Tuesday works." : over.body,
        labelIds: ["SENT"],
        sentAt,
      })
      .returning();
    return m!;
  }

  const row = async (id: string) =>
    (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;
  const deps = (now: Date = NOW) => ({ writerFor: () => writer, now: () => now });

  return { database, user, workspace, mailbox, writer, seed, outbound, row, deps };
}
