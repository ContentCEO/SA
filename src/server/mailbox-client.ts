import "server-only";
import type { Mailbox } from "@/db/schema";
import { mailboxClientFor, type MailboxClient } from "@/mailbox/clients";
import { gmailBudgetFor } from "./gmail-units";
import { saveRotatedRefreshToken } from "./mailboxes";

/**
 * The client every server job uses for a mailbox (Check 47 P2): built through the provider
 * switch, on Gmail's shared unit budget (Check 25 P1), and keeping a rotated refresh token.
 */
export function serverMailboxClient(
  m: Pick<Mailbox, "id" | "provider" | "encryptedRefreshToken">,
): MailboxClient {
  return mailboxClientFor(m, {
    onRefreshTokenRotated: (t) => saveRotatedRefreshToken(m.id, t),
    budget: gmailBudgetFor(m.id),
  });
}
