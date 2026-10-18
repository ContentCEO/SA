import { relativeTime } from "@/lib/relative-time";
import type { MailboxSummary } from "./mailboxes";

/** The 5-minute poll should keep "last checked" fresh; past this, say so plainly. */
export const STALE_SYNC_MS = 30 * 60 * 1000;

export type HealthLine = { label: string; text: string; problem: boolean };

/** A first read that has run this long gets a reassuring extra line (Check 25 P6). */
export const LONG_FIRST_READ_MS = 3 * 60 * 60 * 1000;

/**
 * Check 25 P6: what a first read in progress has done so far. `startedLabel` is the start
 * time already written in the owner's zone ("2:10 PM"); `afterReconnect` when the read began
 * after the owner reconnected (it re-reads 30 days, never "for the first time").
 */
export type FirstReadProgress = {
  count: number;
  startedAt: Date | null;
  startedLabel: string | null;
  afterReconnect: boolean;
};

/** True when mail checking is behind: read once already, and not checked for a while. */
export function syncIsStale(
  m: Pick<MailboxSummary, "backfillCompletedAt" | "lastSyncedAt">,
  now: Date,
): boolean {
  return (
    !!m.backfillCompletedAt &&
    (!m.lastSyncedAt || now.getTime() - m.lastSyncedAt.getTime() > STALE_SYNC_MS)
  );
}

/** The one line under the status banner on every signed-in screen (Check 25 P6). */
export function staleMailLine(lastSyncedAt: Date | null, now: Date): string {
  return `Mail last checked ${lastSyncedAt ? relativeTime(lastSyncedAt, now) : "a while ago"}. New emails may not be here yet. They're safe in Gmail.`;
}
export type MailboxHealth = { lines: HealthLine[]; needsReconnect: boolean };

/**
 * Settings → Your Gmail, in plain sentences (feature plan #44). Only a lost
 * Google connection shows the Reconnect button — it's the only problem the
 * owner can fix; everything else is ours and says so.
 */
export function mailboxHealth(
  m: Pick<
    MailboxSummary,
    "status" | "backfillCompletedAt" | "lastSyncedAt" | "watchExpiresAt" | "lastSyncErrorCode"
  >,
  now: Date,
  pushConfigured: boolean,
  firstRead?: FirstReadProgress,
): MailboxHealth {
  const accessLost = m.status === "reconnect_needed" || m.lastSyncErrorCode === "access_lost";

  const access: HealthLine = accessLost
    ? {
        label: "Google access",
        text: "Removed. Squared Away can't read this inbox until you reconnect.",
        problem: true,
      }
    : m.status === "paused"
      ? { label: "Google access", text: "Paused. Nothing is being read.", problem: false }
      : { label: "Google access", text: "Working.", problem: false };

  let checked: HealthLine;
  if (accessLost) {
    checked = {
      label: "Last checked",
      text: m.lastSyncedAt
        ? `${relativeTime(m.lastSyncedAt, now)}, before access was removed.`
        : "Never.",
      problem: true,
    };
  } else if (m.status === "paused") {
    // Paused on purpose (plan #47): nothing is checked, and that's not a problem of ours.
    checked = { label: "Last checked", text: "Not while it's paused.", problem: false };
  } else if (!m.backfillCompletedAt) {
    const long =
      !!firstRead?.startedAt && now.getTime() - firstRead.startedAt.getTime() > LONG_FIRST_READ_MS;
    const progress = firstRead?.afterReconnect
      ? "Reading your last 30 days again after reconnecting."
      : firstRead
        ? `Reading your last 30 days: ${firstRead.count.toLocaleString("en-US")} email${firstRead.count === 1 ? "" : "s"} so far${firstRead.startedLabel ? `, started ${firstRead.startedLabel}` : ""}.`
        : "Reading your last 30 days.";
    checked = {
      label: "Last checked",
      text: long
        ? `${progress} Big inboxes take a while. New mail is still safe in Gmail.`
        : progress,
      problem: false,
    };
  } else if (!m.lastSyncedAt || syncIsStale(m, now)) {
    checked = {
      label: "Last checked",
      text: `${m.lastSyncedAt ? relativeTime(m.lastSyncedAt, now) : "A while ago"}. That's longer than usual. We keep trying on our own, and your email is safe in Gmail. Nothing for you to do.`,
      problem: true,
    };
  } else if (m.lastSyncErrorCode === "rate_limited") {
    checked = {
      label: "Last checked",
      text: `${relativeTime(m.lastSyncedAt, now)}. Gmail asked us to slow down for a bit; we'll catch up on our own.`,
      problem: false,
    };
  } else {
    checked = {
      label: "Last checked",
      text: `${relativeTime(m.lastSyncedAt, now)}.`,
      problem: false,
    };
  }

  const watching = !!m.watchExpiresAt && m.watchExpiresAt > now;
  const updates: HealthLine = accessLost
    ? { label: "New mail", text: "Not being picked up.", problem: true }
    : syncIsStale(m, now)
      ? {
          // Never promise 5 minutes beside a 42-minute-old check (Check 25 P6).
          label: "New mail",
          text: `Should be every 5 minutes. The last check was ${m.lastSyncedAt ? relativeTime(m.lastSyncedAt, now) : "a while ago"}.`,
          problem: true,
        }
      : pushConfigured && watching
        ? { label: "New mail", text: "Picked up within seconds.", problem: false }
        : pushConfigured
          ? {
              label: "New mail",
              text: "Checked every 5 minutes while instant updates restart.",
              problem: false,
            }
          : { label: "New mail", text: "Checked every 5 minutes.", problem: false };

  return { lines: [access, checked, updates], needsReconnect: accessLost };
}
