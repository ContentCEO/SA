import "server-only";
import type { Mailbox } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import type { MailboxReader, MailboxWriter } from "./connector";
import { createGmailReader } from "./gmail/api";
import type { GmailBudget } from "./gmail/quota";

/** One mailbox's client: read and write in one, whatever the provider. */
export type MailboxClient = MailboxReader & MailboxWriter & { gmailUnits?(): number };

export type MailboxClientOptions = {
  /**
   * Some providers hand out a new refresh token on a refresh (Microsoft does, and says to
   * replace the old one). Called with the new token so it can be stored; never logged.
   */
  onRefreshTokenRotated?: (token: string) => Promise<void>;
  /** Gmail's shared per-mailbox unit budget (Check 25 P1). */
  budget?: GmailBudget;
};

/**
 * Check 47 P2: the one place a mailbox client is built. Shared code never builds a provider's
 * client itself, so Outlook is a second case here, not edits across sync, drafts and voice.
 */
export function mailboxClientFor(
  m: Pick<Mailbox, "id" | "provider" | "encryptedRefreshToken">,
  opts: MailboxClientOptions = {},
): MailboxClient {
  switch (m.provider) {
    case "gmail":
      return createGmailReader({
        refreshToken: decryptSecret(m.encryptedRefreshToken),
        onRefreshTokenRotated: opts.onRefreshTokenRotated,
        mailboxId: m.id,
        budget: opts.budget,
      });
    case "outlook":
      // Plan #49: the Outlook client arrives with src/mailbox/outlook/ (next step). No outlook
      // row can exist before then: nothing saves one.
      throw new Error("No mailbox client for provider outlook yet.");
    default: {
      const unknown: never = m.provider;
      throw new Error(`No mailbox client for provider ${String(unknown)}.`);
    }
  }
}
