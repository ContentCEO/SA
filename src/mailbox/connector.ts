import type { mailboxProviderEnum } from "@/db/schema";

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

/** Every provider the schema knows (`mailboxes.provider`). */
export type MailboxProvider = (typeof mailboxProviderEnum.enumValues)[number];

export interface MailboxConnector {
  readonly provider: MailboxProvider;
  /** Scopes we must have. Missing any of them means we refuse the connection. */
  readonly requiredScopes: readonly string[];
  /** URL to send the owner to for consent. `state` is our CSRF token. */
  authorizationUrl(opts: {
    state: string;
    redirectUri: string;
    loginHint?: string;
    /**
     * Check 42 P3: Google's `prompt`. Default "consent" (a refresh token every time);
     * "consent select_account" shows Google's account chooser (adding another inbox).
     */
    prompt?: "consent" | "consent select_account";
  }): string;
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

/**
 * Check 47 P1: the Google account has no Gmail (Gmail answers "Mail service not enabled"): a
 * Google account made for Business Profile or Ads while the email lives on Outlook, or a
 * Workspace with Gmail turned off. Nothing is saved and the token is revoked.
 */
export class NoGmailError extends Error {
  constructor() {
    super("This Google account has no Gmail.");
    this.name = "NoGmailError";
  }
}

/**
 * Check 47 P4: the label names shared code reads. They are Gmail's own, and every provider's
 * reader maps its folders onto exactly these (an Outlook reader puts "INBOX" on inbox mail,
 * "SENT" on sent mail, …). Stored `messages.label_ids` hold these values.
 */
export const MAIL_LABELS = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
} as const;

/** A message as the sync engine sees it, independent of provider. */
export type MailMessage = {
  providerMessageId: string;
  providerThreadId: string;
  /** The message's labels, as the names in MAIL_LABELS (plus any the provider adds). */
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
    /** The Reply-To header as given (website forms put the customer here). */
    replyTo?: string;
    /**
     * True only when the request could have returned Reply-To (a full read, or a metadata
     * read that asked for it). "Read, none there" and "never asked" are different facts:
     * only the first may be stored as "no Reply-To".
     */
    replyToRead?: boolean;
    /**
     * Check 20 P4 / 21 P1: machine-written mail (RFC 3834). Read only to set
     * `messages.auto_reply`; never stored or logged. Undefined = not present (or not asked).
     */
    autoSubmitted?: string;
    xAutoreply?: string;
    xAutorespond?: string;
    precedence?: string;
    autoResponseSuppress?: string;
  };
  /** Only present when fetched with bodies. */
  bodyText?: string;
  /**
   * Check 40 P2: attachments by kind (full reads only). Counts only — never names or content.
   */
  attachments?: { images: number; pdfs: number; other: number };
};

export type MessageRef = {
  id: string;
  threadId: string;
  /**
   * Labels, when the listing already said (history's messagesAdded, or an `in:inbox` listing).
   * Only a hint for how to read the message (Check 25 P1); what's stored comes from the read.
   */
  labelIds?: string[];
};

/** A label change history reported on one message (Check 25 P2). */
export type LabelChange = { id: string; threadId: string; added: string[]; removed: string[] };

export type HistoryPage = {
  /** New messages, plus messages that gained SENT (a sent draft may keep its id). */
  added: MessageRef[];
  /** Every label added or removed, in history order (archive, Trash, Spam, Not spam…). */
  labelChanges: LabelChange[];
  /** Messages deleted for good in Gmail. */
  deleted: MessageRef[];
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
  /**
   * Check 47 P4: a listing by window, never a provider's own search words. `after` (a fixed
   * start) wins over `newerThanDays`; `inbox` true = inbox only, false = everything but the
   * inbox; `sentOnly` = the owner's sent mail. Spam and Trash are never listed.
   */
  listMessages(opts: {
    newerThanDays?: number;
    after?: Date;
    inbox?: boolean;
    sentOnly?: boolean;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{
    messages: MessageRef[];
    nextPageToken?: string;
  }>;
  /**
   * `headers` (metadata reads only): ask for just these headers instead of the default list
   * (the Reply-To backfill asks for ["Reply-To"] only).
   */
  getMessage(
    id: string,
    opts: { withBody: boolean; headers?: readonly string[] },
  ): Promise<MailMessage | null>;
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

/**
 * Gmail kept saying "slow down" after our in-call retries. Not a failure of
 * the mailbox — the job should pause for a few minutes and pick up again.
 */
export class MailboxRateLimitError extends Error {
  constructor(
    message = "Gmail asked us to slow down.",
    /** When Gmail said to try again, if it said. */
    public readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "MailboxRateLimitError";
  }
}

/** Check 25 P5: Gmail refused a saved listing page token (400): start the listing over. */
export class InvalidPageTokenError extends Error {
  constructor() {
    super("Gmail no longer accepts that page token.");
    this.name = "InvalidPageTokenError";
  }
}

/** The stored sync cursor is too old; fall back to a fresh window sync. */
export class HistoryExpiredError extends Error {
  constructor() {
    super("Sync cursor expired.");
    this.name = "HistoryExpiredError";
  }
}

/** A Gmail draft as we see it when reconciling. */
export type RemoteDraft = {
  draftId: string;
  messageId: string;
  threadId: string;
  bodyText: string;
};

/**
 * Write-side of a mailbox: drafts only. Sending is always "send this draft",
 * never "send arbitrary mail", so every sent email existed as a visible draft first.
 */
export interface MailboxWriter {
  createDraft(opts: {
    threadId: string;
    raw: string;
  }): Promise<{ draftId: string; messageId: string }>;
  /** null when the owner deleted it (or sent it) in Gmail. */
  getDraft(draftId: string): Promise<RemoteDraft | null>;
  updateDraft(
    draftId: string,
    opts: { threadId: string; raw: string },
  ): Promise<{ messageId: string }>;
  /** Must not throw if it's already gone. */
  deleteDraft(draftId: string): Promise<void>;
  /**
   * Message ids of every unsent draft in a thread (ours and the owner's own), [] when the
   * thread is gone. Autopilot asks this just before sending: the owner may be writing their own
   * reply in Gmail. Only ids — never stored, never logged.
   */
  threadDraftMessageIds(threadId: string): Promise<string[]>;
  /**
   * Check 20 P2: every message in a thread with its labels, in Gmail's order (oldest first),
   * [] when the thread is gone. The same one call as `threadDraftMessageIds` (ids and labels
   * only: no headers, snippet or text). Autopilot uses it just before sending to see the
   * owner's own drafts AND mail that hasn't synced yet. Never stored, never logged.
   */
  threadMessageLabels(threadId: string): Promise<{ id: string; labelIds: string[] }[]>;
  sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }>;
  /**
   * Send a brand-new message (not a draft, not in any thread). Used only for
   * practice sends to the owner's own address during evaluation (plan #40).
   */
  sendMessage(raw: string): Promise<{ messageId: string }>;
}
