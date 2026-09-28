import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { invites, users, workspaces, type User, type Workspace } from "@/db/schema";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** Invite-only: the email must be on the invite list, or be Davi's admin address. */
export async function isAllowedToSignIn(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const admin = process.env.ADMIN_EMAIL && normalizeEmail(process.env.ADMIN_EMAIL);
  if (admin && e === admin) return true;
  const [row] = await db()
    .select({ email: invites.email })
    .from(invites)
    .where(eq(invites.email, e));
  return Boolean(row);
}

/** Idempotent: first sign-in creates the user and their workspace. */
export async function ensureUserAndWorkspace(input: {
  email: string;
  name?: string | null;
}): Promise<{ user: User; workspace: Workspace }> {
  const email = normalizeEmail(input.email);
  const [user] = await db()
    .insert(users)
    .values({ email, name: input.name ?? null })
    .onConflictDoUpdate({
      target: users.email,
      set: { name: sql`coalesce(excluded.name, ${users.name})` },
    })
    .returning();
  if (!user) throw new Error("Could not create user.");

  const [invite] = await db().select().from(invites).where(eq(invites.email, email));
  await db()
    .insert(workspaces)
    .values({ ownerUserId: user.id, trade: invite?.trade ?? null })
    .onConflictDoNothing({ target: workspaces.ownerUserId });
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, user.id));
  if (!workspace) throw new Error("Could not create workspace.");

  if (invite && !invite.acceptedAt) {
    await db().update(invites).set({ acceptedAt: new Date() }).where(eq(invites.email, email));
  }
  return { user, workspace };
}

export async function getWorkspaceForUser(userId: string): Promise<Workspace | undefined> {
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId));
  return workspace;
}
