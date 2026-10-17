import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { invites, users, workspaces, type User, type Workspace } from "@/db/schema";
import { linkGrowthInvite } from "./growth-clients";
import { referralRefusal, referralsVisible } from "./referral-rules";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * The invite rows that let these addresses sign in: an exact match on the normalized address,
 * the same test the sign-in gate uses. Shared with the /admin waitlist card so it never shows
 * "Invited" for someone the gate would turn away.
 */
export function inviteForEmails(emails: string[]) {
  return inArray(invites.email, emails.map(normalizeEmail));
}

/** Invite-only: the email must be on the invite list, or be Davi's admin address. */
export async function isAllowedToSignIn(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const admin = process.env.ADMIN_EMAIL && normalizeEmail(process.env.ADMIN_EMAIL);
  if (admin && e === admin) return true;
  const [row] = await db()
    .select({ email: invites.email })
    .from(invites)
    .where(inviteForEmails([e]));
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
  // Plan #47: only while referrals are switched on (flag and amount) does a referral carry onto
  // the new workspace. Either way the first workspace uses it up (below).
  const referral =
    invite?.referredByWorkspaceId && referralsVisible() ? invite.referredByWorkspaceId : null;
  const referredBy = referral ? await allowedReferrer(referral, email) : null;
  await db().transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaces)
      .values({
        ownerUserId: user.id,
        trade: invite?.trade ?? null,
        referredByWorkspaceId: referredBy,
      })
      .onConflictDoNothing({ target: workspaces.ownerUserId })
      .returning({ id: workspaces.id });
    // The invite's referral is used up by the first workspace (A5), whether or not referrals were
    // on at that moment: deleting the account and signing in again never links it to the
    // referrer later, so a sign-up made while the switch was off can never be paid afterwards.
    if (created && invite?.referredByWorkspaceId) {
      await tx.update(invites).set({ referredByWorkspaceId: null }).where(eq(invites.email, email));
    }
  });
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, user.id));
  if (!workspace) throw new Error("Could not create workspace.");

  if (invite && !invite.acceptedAt) {
    await db().update(invites).set({ acceptedAt: new Date() }).where(eq(invites.email, email));
  }
  // Squared Away Growth: Davi's "Invite to Growth" makes this account a Growth client (once).
  // It starts no trial: the app's clock still starts only when Gmail is connected. A failure
  // here never stops the sign-in; the invite stays marked, so the next sign-in tries again.
  if (invite?.growthInvitedAt) {
    try {
      await linkGrowthInvite(email, workspace.id);
    } catch (err) {
      console.error("growth_invite_link_failed", {
        workspaceId: workspace.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { user, workspace };
}

/** The referrer's workspace id if this sign-up may count as their referral, else null. */
async function allowedReferrer(referrerId: string, email: string): Promise<string | null> {
  const [referrer] = await db()
    .select({ email: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, referrerId));
  if (!referrer) return null;
  const refusal = referralRefusal(
    { workspaceId: referrerId, ownerEmail: referrer.email },
    { workspaceId: "", ownerEmail: email },
  );
  return refusal ? null : referrerId;
}

export async function getWorkspaceForUser(userId: string): Promise<Workspace | undefined> {
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId));
  return workspace;
}
