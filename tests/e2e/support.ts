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
export async function seedOwner(opts: { mailbox?: boolean } = {}) {
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
      })
      .returning();
    mailboxId = m!.id;
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
