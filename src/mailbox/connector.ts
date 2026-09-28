/**
 * Mailbox connector interface. Only Gmail is implemented; Outlook would be a
 * second implementation of this, not a rewrite. Sync and send methods are
 * added in later milestones.
 */
export type ConnectResult = {
  email: string;
  refreshToken: string;
  grantedScopes: string[];
};

export interface MailboxConnector {
  readonly provider: "gmail";
  /** Scopes we must have. Missing any of them means we refuse the connection. */
  readonly requiredScopes: readonly string[];
  /** URL to send the owner to for consent. `state` is our CSRF token. */
  authorizationUrl(opts: { state: string; redirectUri: string; loginHint?: string }): string;
  /** Exchange the callback code for a long-lived credential. */
  exchangeCode(opts: { code: string; redirectUri: string }): Promise<ConnectResult>;
  /** Revoke our access at the provider. Must not throw if already revoked. */
  revoke(refreshToken: string): Promise<void>;
}

export class MissingScopesError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required scopes: ${missing.join(", ")}`);
    this.name = "MissingScopesError";
  }
}
