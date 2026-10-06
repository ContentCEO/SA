import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, users, workspaces } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import type { MailboxConnector } from "@/mailbox/connector";
import { cancelSubscriptionNow } from "./billing";

export class SubscriptionCancelError extends Error {
  constructor() {
    super("Couldn't cancel the plan at Stripe, so nothing was deleted.");
    this.name = "SubscriptionCancelError";
  }
}

/**
 * The owner's "Delete my account and data". In this order, so nothing is left
 * half-done in a way that costs them:
 *   1. cancel the Stripe subscription now (if that fails, stop — never leave
 *      someone paying for an account that's gone);
 *   2. remove our access at Google for every connected mailbox (best effort,
 *      like Disconnect — the owner asked us to let go);
 *   3. delete the user row; everything else cascades (workspace, mailboxes,
 *      threads, messages, drafts, profiles, rules, usage, activity).
 * Stripe keeps its own payment records (invoices), as the law requires.
 */
export async function deleteAccount(userId: string, connector: MailboxConnector) {
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId));

  let subscriptionCanceled = false;
  if (workspace?.stripeSubscriptionId) {
    try {
      await cancelSubscriptionNow(workspace.stripeSubscriptionId);
      subscriptionCanceled = true;
    } catch {
      throw new SubscriptionCancelError();
    }
  }

  const boxes = workspace
    ? await db().select().from(mailboxes).where(eq(mailboxes.workspaceId, workspace.id))
    : [];
  let revoked = 0;
  for (const m of boxes) {
    try {
      await connector.revoke(decryptSecret(m.encryptedRefreshToken));
      revoked++;
    } catch {
      // Deleting our copy still removes our access; the screen points to Google's page too.
    }
  }

  await db().delete(users).where(eq(users.id, userId));
  console.info("account_deleted", {
    workspaceId: workspace?.id ?? null,
    mailboxes: boxes.length,
    revokedAtProvider: revoked,
    subscriptionCanceled,
  });
  return { mailboxes: boxes.length, revoked, subscriptionCanceled };
}
