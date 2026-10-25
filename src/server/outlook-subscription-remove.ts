import "server-only";
import { outlookOffered } from "@/config/outlook";
import type { Mailbox } from "@/db/schema";
import { mailboxClientFor, type MailboxClient } from "@/mailbox/clients";

/**
 * Plan #49: Disconnect / Delete my account drop the mailbox's Graph subscription at Microsoft,
 * best effort: a failure never stops the delete (an orphan expires within a week, and its
 * notifications match no mailbox). Only when Outlook is offered — otherwise no Microsoft host
 * is contacted. Apart from outlook-push.ts so the mailbox code doesn't import sync.
 */
export async function removeOutlookSubscription(
  m: Pick<Mailbox, "id" | "provider" | "encryptedRefreshToken" | "pushSubscriptionId">,
  deps: {
    clientFor?: (
      m: Pick<Mailbox, "id" | "provider" | "encryptedRefreshToken">,
    ) => Pick<MailboxClient, "pushSubscriptions">;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  if (m.provider !== "outlook" || !m.pushSubscriptionId || !outlookOffered(deps.env)) return;
  try {
    await (deps.clientFor ?? mailboxClientFor)(m).pushSubscriptions?.remove(m.pushSubscriptionId);
  } catch (err) {
    console.error("outlook_subscription_remove_failed", {
      mailboxId: m.id,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
