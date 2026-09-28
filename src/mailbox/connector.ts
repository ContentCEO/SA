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

/** A message as the sync engine sees it, independent of provider. */
export type MailMessage = {
  providerMessageId: string;
  providerThreadId: string;
  labelIds: string[];
  snippet: string;
  /** Epoch millis when the provider received/sent it. */
  internalDate: number;
  headers: {
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    messageId?: string;
    references?: string;
    inReplyTo?: string;
  };
  /** Only present when fetched with bodies. */
  bodyText?: string;
};

export type MessageRef = { id: string; threadId: string };

export type HistoryPage = {
  added: MessageRef[];
  nextPageToken?: string;
  /** Newest cursor seen; store it once the page is processed. */
  historyId: string;
};

/**
 * Read-side of a mailbox, used by sync. One instance per mailbox per run; it
 * owns refreshing its own access token.
 */
export interface MailboxReader {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessages(opts: { query: string; pageToken?: string; maxResults?: number }): Promise<{
    messages: MessageRef[];
    nextPageToken?: string;
  }>;
  getMessage(id: string, opts: { withBody: boolean }): Promise<MailMessage | null>;
  /** Throws HistoryExpiredError when the cursor is too old to resume from. */
  listHistory(opts: { startHistoryId: string; pageToken?: string }): Promise<HistoryPage>;
  watch(topicName: string): Promise<{ historyId: string; expiration: number }>;
}

/** The owner revoked access or the refresh token is dead. Stop everything for this mailbox. */
export class MailboxAuthError extends Error {
  constructor(message = "Mailbox access was revoked.") {
    super(message);
    this.name = "MailboxAuthError";
  }
}

/** The stored sync cursor is too old; fall back to a fresh window sync. */
export class HistoryExpiredError extends Error {
  constructor() {
    super("Sync cursor expired.");
    this.name = "HistoryExpiredError";
  }
}
