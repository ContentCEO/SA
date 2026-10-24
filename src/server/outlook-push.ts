import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { outlookOffered } from "@/config/outlook";
import { db } from "@/db";
import { mailboxes, workspaces, type Mailbox } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { MailboxAuthError } from "@/mailbox/connector";
import type { MailboxClient } from "@/mailbox/clients";
import { SUBSCRIPTION_MINUTES } from "@/mailbox/outlook/subscriptions";
import { jobsAllowed } from "./lifecycle";
import { serverMailboxClient } from "./mailbox-client";
import { mailboxRunning } from "./mailbox-plan";
import { markReconnectNeeded } from "./sync";

/**
 * Plan #49: Outlook push. Off unless Outlook is offered (FEATURE_OUTLOOK + the Azure app's
 * credentials): then not one query runs and no Microsoft host is contacted. Each running
 * Outlook mailbox of an account that may run jobs, once its first read is done, holds one Graph
 * change subscription, renewed by the daily watch job when under two days are left (Graph's
 * limit is 10,080 minutes; we ask for 10,000). The random `clientState` Microsoft echoes on every
 * notification is stored only as its sha256. The 5-minute poll still syncs every Outlook
 * mailbox, push or not (`pollDue` treats push as on only for Gmail), so a lost subscription
 * costs at most five minutes.
 */

export const OUTLOOK_NOTIFY_PATH = "/api/outlook/notify";
export const RENEW_WITHIN_MS = 2 * 86_400_000;

export const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

/** Constant-time check of a notification's clientState against the stored hash. */
export function clientStateMatches(stored: string | null, received: unknown): boolean {
  if (!stored || typeof received !== "string" || !received) return false;
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(sha256Hex(received), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a mailbox's subscription should be made or renewed now. */
export function subscriptionDue(
  m: Pick<Mailbox, "pushSubscriptionId" | "watchExpiresAt">,
  now: Date,
): boolean {
  return (
    !m.pushSubscriptionId ||
    !m.watchExpiresAt ||
    m.watchExpiresAt.getTime() - now.getTime() < RENEW_WITHIN_MS
  );
}

export type OutlookPushDeps = {
  clientFor?: (m: Mailbox) => Pick<MailboxClient, "pushSubscriptions">;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

/** Create or renew one mailbox's subscription. */
async function ensureSubscription(
  m: Mailbox,
  client: Pick<MailboxClient, "pushSubscriptions">,
  now: Date,
): Promise<boolean> {
  const subs = client.pushSubscriptions;
  if (!subs) return false;
  const expiresAt = new Date(now.getTime() + SUBSCRIPTION_MINUTES * 60_000);
  if (m.pushSubscriptionId) {
    const renewed = await subs.renew(m.pushSubscriptionId, expiresAt);
    if (renewed) {
      await db()
        .update(mailboxes)
        .set({ watchExpiresAt: renewed.expiresAt })
        .where(eq(mailboxes.id, m.id));
      return true;
    }
  }
  const clientState = randomBytes(32).toString("base64url");
  const created = await subs.create({
    notificationUrl: appUrl(OUTLOOK_NOTIFY_PATH),
    clientState,
    expiresAt,
  });
  await db()
    .update(mailboxes)
    .set({
      pushSubscriptionId: created.id,
      pushClientStateSha256: sha256Hex(clientState),
      watchExpiresAt: created.expiresAt,
    })
    .where(eq(mailboxes.id, m.id));
  return true;
}

/** The daily job: make or renew every due Outlook subscription. Returns how many. */
export async function renewOutlookSubscriptions(deps: OutlookPushDeps = {}): Promise<number> {
  if (!outlookOffered(deps.env)) return 0;
  const now = deps.now?.() ?? new Date();
  const soon = new Date(now.getTime() + RENEW_WITHIN_MS);
  const rows = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(
      and(
        eq(mailboxes.provider, "outlook"),
        mailboxRunning(),
        isNotNull(mailboxes.backfillCompletedAt),
        or(
          isNull(mailboxes.pushSubscriptionId),
          isNull(mailboxes.watchExpiresAt),
          lt(mailboxes.watchExpiresAt, soon),
        ),
      ),
    );
  let done = 0;
  for (const { mailbox, workspace } of rows) {
    // Read-only accounts aren't synced: nothing for a notification to wake.
    if (!jobsAllowed(workspace, now)) continue;
    try {
      const client = (deps.clientFor ?? serverMailboxClient)(mailbox);
      if (await ensureSubscription(mailbox, client, now)) done++;
    } catch (err) {
      if (err instanceof MailboxAuthError) await markReconnectNeeded(mailbox);
      else
        console.error("outlook_subscription_failed", {
          mailboxId: mailbox.id,
          error: err instanceof Error ? err.name : "unknown",
        });
    }
  }
  return done;
}

/**
 * Disconnect / Delete my account: drop the subscription at Microsoft, best effort (a failure
 * never stops the delete; an orphan expires by itself within a week and its notifications
 * match no mailbox). Only when Outlook is offered — otherwise no Microsoft host is contacted.
 */
export async function removeOutlookSubscription(
  m: Pick<Mailbox, "id" | "provider" | "encryptedRefreshToken" | "pushSubscriptionId">,
  deps: OutlookPushDeps = {},
): Promise<void> {
  if (m.provider !== "outlook" || !m.pushSubscriptionId || !outlookOffered(deps.env)) return;
  try {
    const client = (deps.clientFor ?? serverMailboxClient)(m as Mailbox);
    await client.pushSubscriptions?.remove(m.pushSubscriptionId);
  } catch (err) {
    console.error("outlook_subscription_remove_failed", {
      mailboxId: m.id,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
