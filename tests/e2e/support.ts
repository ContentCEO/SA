import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { encode } from "next-auth/jwt";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/crypto";

const client = postgres(process.env.DATABASE_URL!, { max: 2 });
export const testDb = drizzle(client, { schema });

/** A fresh invited owner with a workspace, optionally with a connected mailbox. */
export async function seedOwner(
  opts: {
    mailbox?: boolean;
    status?: "active" | "reconnect_needed";
    backfilled?: boolean;
    messageCount?: number;
  } = {},
) {
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
  await testDb.insert(schema.invites).values({ email, trade: "plumbing" });
  const [user] = await testDb
    .insert(schema.users)
    .values({ email, name: "Test Owner" })
    .returning();
  const [workspace] = await testDb
    .insert(schema.workspaces)
    .values({ ownerUserId: user!.id, trade: "plumbing" })
    .returning();
  let mailboxId: string | undefined;
  if (opts.mailbox) {
    const [m] = await testDb
      .insert(schema.mailboxes)
      .values({
        workspaceId: workspace!.id,
        email,
        encryptedRefreshToken: encryptSecret("fake-refresh-token"),
        scopes: "gmail",
        status: opts.status ?? "active",
        backfillCompletedAt: opts.backfilled ? new Date() : null,
        lastSyncedAt: opts.backfilled ? new Date() : null,
      })
      .returning();
    mailboxId = m!.id;
    if (opts.messageCount) {
      const [t] = await testDb
        .insert(schema.threads)
        .values({ mailboxId, gmailThreadId: "t-e2e", inInbox: true })
        .returning();
      await testDb.insert(schema.messages).values(
        Array.from({ length: opts.messageCount }, (_, i) => ({
          threadId: t!.id,
          mailboxId: mailboxId!,
          gmailMessageId: `m-e2e-${i}`,
          direction: "in" as const,
          sentAt: new Date(),
        })),
      );
    }
  }
  return { email, userId: user!.id, workspaceId: workspace!.id, mailboxId };
}

export async function mailboxCount(workspaceId: string) {
  const rows = await testDb
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.workspaceId, workspaceId));
  return rows.length;
}

/** Sign in without Google by minting the same session cookie Auth.js would. */
export async function signInAs(context: BrowserContext, owner: { userId: string; email: string }) {
  const cookieName = "authjs.session-token";
  const value = await encode({
    secret: process.env.AUTH_SECRET!,
    salt: cookieName,
    token: { sub: owner.userId, uid: owner.userId, email: owner.email, name: "Test Owner" },
  });
  const url = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100");
  await context.addCookies([
    { name: cookieName, value, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** A needs-you complaint (Dana) and a quote with a pending draft (Priya). */
export async function seedQueue(mailboxId: string) {
  const mk = async (g: string, over: Partial<typeof schema.threads.$inferInsert>, from: string) => {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId,
        gmailThreadId: `${g}-${mailboxId}`,
        inInbox: true,
        lastMessageAt: new Date(),
        ...over,
      })
      .returning();
    const [m] = await testDb
      .insert(schema.messages)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m-${g}-${mailboxId}`,
        direction: "in",
        fromName: from,
        fromAddress: `${from.toLowerCase()}@x.com`,
        sentAt: new Date(),
      })
      .returning();
    return { t: t!, m: m! };
  };
  const complaint = await mk(
    "c",
    {
      category: "complaint",
      needsOwner: true,
      needsOwnerReason: "Customer says the leak came back.",
      summary: "Leak is back.",
    },
    "Dana",
  );
  const quote = await mk(
    "q",
    { category: "quote_request", summary: "Panel upgrade quote." },
    "Priya",
  );
  const [draft] = await testDb
    .insert(schema.drafts)
    .values({
      threadId: quote.t.id,
      mailboxId,
      replyToMessageId: quote.m.id,
      gmailDraftId: "fake-draft",
      toAddress: "priya@x.com",
      subject: "Re: Panel",
      body: "Hey Priya,\n\nWhat's the address, and how old is the current panel?\n\nThanks, Davi",
      originalBody: "same",
      reason: "Quote request, panel upgrade. Asked for the address and panel age.",
      flags: ["Check you can do Tuesday morning."],
      confidence: 85,
    })
    .returning();
  return { complaint, quote, draft: draft! };
}

/** Set where a seeded owner is in the commercial flow. */
export async function setWorkspace(
  workspaceId: string,
  values: Partial<typeof schema.workspaces.$inferInsert>,
) {
  await testDb.update(schema.workspaces).set(values).where(eq(schema.workspaces.id, workspaceId));
}

/** The ADMIN_EMAIL user (created once, reused across tests). */
export async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL!.toLowerCase();
  await testDb.insert(schema.users).values({ email, name: "Davi" }).onConflictDoNothing();
  const [user] = await testDb.select().from(schema.users).where(eq(schema.users.email, email));
  await testDb
    .insert(schema.workspaces)
    .values({ ownerUserId: user!.id, status: "active" })
    .onConflictDoNothing();
  return { email, userId: user!.id };
}
