import "server-only";
import { eq, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, invites, mailboxes, users, workspaces } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import type { MailboxConnector } from "@/mailbox/connector";
import { cancelSubscriptionNow, liveSubscriptionIds, workspaceBillingKeyPattern } from "./billing";

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
 *   3. in one transaction: delete the user row (everything else cascades: workspace,
 *      mailboxes, threads, messages, drafts, edit counts, price memory, profiles, rules,
 *      usage, activity, seasonal notes, style suggestions, phone notifications), their
 *      invite (coming back needs a new one) and our markers keyed by the workspace (the
 *      monthly cost alert, sent-email records).
 * Stripe keeps its own payment records (invoices), as the law requires. Left on purpose: a
 * waitlist entry or Growth call request (a separate service; the owner can ask us), referral
 * credits (a salted email fingerprint with the workspace ids cleared, so a referral is paid
 * once), Stripe event ids, rate-limit counters (purged within two days), and the draft
 * cleanup's per-mailbox done marker (a bare uuid, never read once the mailbox is gone).
 * tests/unit/data-lifecycle.test.ts holds every table to this.
 */
export async function deleteAccount(userId: string, connector: MailboxConnector) {
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId));

  // Check 17 P4: every live subscription of the customer, not just the stored one (a second
  // paid checkout would keep charging). If any cancel fails, nothing is deleted.
  let subscriptionCanceled = false;
  if (workspace?.stripeSubscriptionId || workspace?.stripeCustomerId) {
    try {
      const ids = await liveSubscriptionIds(
        workspace.stripeCustomerId,
        workspace.stripeSubscriptionId,
      );
      for (const id of ids) await cancelSubscriptionNow(id);
      subscriptionCanceled = ids.length > 0;
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

  await db().transaction(async (tx) => {
    const [user] = await tx
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ email: users.email });
    if (user) await tx.delete(invites).where(sql`lower(${invites.email}) = lower(${user.email})`);
    if (workspace) {
      const ids = [workspace.id, ...boxes.map((m) => m.id)];
      await tx.delete(appSettings).where(
        or(
          like(appSettings.key, `cost_alert:${workspace.id}:%`),
          // Billing markers (open checkout, second plan, waiting on Stripe).
          like(appSettings.key, workspaceBillingKeyPattern(workspace.id)),
          // Resend sent-records ("email-sent:digest-<workspace>-<date>",
          // "email-sent:access-lost-<mailbox>-…"); uuids hold no LIKE wildcards.
          ...ids.map((id) => like(appSettings.key, `email-sent:%-${id}-%`)),
        ),
      );
    }
  });
  console.info("account_deleted", {
    workspaceId: workspace?.id ?? null,
    mailboxes: boxes.length,
    revokedAtProvider: revoked,
    subscriptionCanceled,
  });
  return { mailboxes: boxes.length, revoked, subscriptionCanceled };
}
