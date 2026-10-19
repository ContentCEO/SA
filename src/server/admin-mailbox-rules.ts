/**
 * Check 16 P1: the Mailboxes line on an /admin account card, in plain words. Counts, times and a
 * fixed error code only — never an address, subject or message text. Pure (no database).
 */

export type MailboxCounts = {
  total: number;
  needReconnect: number;
  stale: number;
  oldestStaleSyncAt: Date | null;
  stuckFirstRead: number;
  errorCode: string | null;
};

/** "6 hours", "45 minutes", "3 days". */
export function waitedFor(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

const CODE_PHRASE: Record<string, string> = {
  rate_limited: "Gmail asked us to slow down",
  sync_failed: "checks failing",
};

/** True when something other than the owner's own reconnect is wrong (the card says "Stuck"). */
export function mailboxesStuck(m: MailboxCounts): boolean {
  return m.stale > 0 || m.stuckFirstRead > 0 || (!!m.errorCode && m.errorCode in CODE_PHRASE);
}

/** The Mailboxes stat. "healthy" only when nothing at all applies. */
export function mailboxesLine(m: MailboxCounts, now: Date): string {
  if (m.total === 0) return "None connected";
  const parts: string[] = [];
  if (m.needReconnect) parts.push(`${m.needReconnect} need reconnect`);
  if (m.stale) {
    parts.push(
      m.oldestStaleSyncAt
        ? `not checked for ${waitedFor(now.getTime() - m.oldestStaleSyncAt.getTime())}`
        : "never checked",
    );
  }
  if (m.stuckFirstRead) parts.push("still on first read");
  if (m.errorCode && CODE_PHRASE[m.errorCode]) parts.push(CODE_PHRASE[m.errorCode]!);
  return `${m.total}, ${parts.length ? parts.join(", ") : "healthy"}`;
}

/**
 * Check 27 P2: the privacy policy and terms show an email for data requests only when
 * SUPPORT_EMAIL is set (otherwise a text link). The System box says so: a plain line anywhere it
 * is missing, and the box inverts in production, where real people read /privacy.
 */
export const NO_SUPPORT_EMAIL_LINE =
  "No support email set. The privacy policy has no email for data requests.";

export function supportEmailWarning(env: {
  SUPPORT_EMAIL?: string;
  VERCEL_ENV?: string;
}): { line: string; inverts: boolean } | null {
  if (env.SUPPORT_EMAIL?.trim()) return null;
  return { line: NO_SUPPORT_EMAIL_LINE, inverts: env.VERCEL_ENV === "production" };
}

/** Plain lines for the System box. */
export function systemTroubleLines(h: { staleMailboxes: number; stuckFirstReads: number }) {
  const lines: string[] = [];
  if (h.staleMailboxes > 0) {
    lines.push(
      h.staleMailboxes === 1
        ? "1 inbox hasn't been checked for over 30 minutes."
        : `${h.staleMailboxes} inboxes haven't been checked for over 30 minutes.`,
    );
  }
  if (h.stuckFirstReads > 0) {
    lines.push(
      h.stuckFirstReads === 1
        ? "1 inbox is still on its first read after 2 hours."
        : `${h.stuckFirstReads} inboxes are still on their first read after 2 hours.`,
    );
  }
  return lines;
}
