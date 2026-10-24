import "server-only";
import type { MailboxConnector, MailboxProvider } from "./connector";
import { createGmailConnector } from "./gmail/connector";
import { createOutlookConnector } from "./outlook/connector";

/**
 * Plan #49: the connector for a stored mailbox's provider. Revoke goes to the provider that
 * issued the token, never another one (a Microsoft token is never sent to Google's revoke).
 */
export function connectorFor(provider: MailboxProvider): MailboxConnector {
  switch (provider) {
    case "gmail":
      return createGmailConnector();
    case "outlook":
      return createOutlookConnector();
    default: {
      const unknown: never = provider;
      throw new Error(`No connector for provider ${String(unknown)}.`);
    }
  }
}

/** The given connector when it is this provider's (tests pass fakes), else the real one. */
export function connectorForRow(
  given: MailboxConnector,
  provider: MailboxProvider,
): MailboxConnector {
  // A connector without a provider (a bare test stand-in) is taken as given.
  return given.provider === undefined || given.provider === provider
    ? given
    : connectorFor(provider);
}
