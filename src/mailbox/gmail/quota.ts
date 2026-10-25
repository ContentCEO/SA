/**
 * Gmail's per-user quota, in Google's own units (Check 25 P1).
 *
 * Source: developers.google.com/workspace/gmail/api/reference/quota (last updated 2026-09-10):
 * 6,000 quota units per minute per user per project. A full or metadata message read costs 20,
 * so one inbox can take about 5 reads a second, whatever the concurrency.
 */
export const GMAIL_UNITS = {
  getProfile: 1,
  "messages.list": 5,
  "messages.get": 20,
  "history.list": 2,
  "drafts.get": 20,
  "drafts.create": 10,
  "drafts.update": 15,
  "drafts.delete": 10,
  "drafts.send": 100,
  "messages.send": 100,
  "threads.get": 40,
  // Check 42 P4: users.settings.sendAs.list (addresses only), read at connect and daily.
  "settings.sendAs.list": 1,
  watch: 100,
} as const;

export type GmailMethod = keyof typeof GMAIL_UNITS;

/** Google allows 6,000 a minute per user; we stop at 90% so a burst never trips its limit. */
export const GMAIL_UNITS_PER_MINUTE = 5_400;

/** The start of the minute `now` falls in (the budget's window). */
export function minuteStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/** The start of the next minute: when a spent budget opens again. */
export function nextMinute(now: Date): Date {
  return new Date(minuteStart(now).getTime() + 60_000);
}

/**
 * A per-mailbox unit budget the Gmail client reserves from before every request. Kept in the
 * database (src/server/gmail-units.ts) so every job reading the same inbox shares one budget.
 */
export interface GmailBudget {
  /** Reserve units, or throw MailboxRateLimitError (retryAt = when to come back). */
  reserve(method: GmailMethod): Promise<void>;
  /** Gmail itself said "slow down until …": every job for this inbox waits until then. */
  coolUntil(at: Date): Promise<void>;
}
