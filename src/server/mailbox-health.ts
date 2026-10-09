import { relativeTime } from "@/lib/relative-time";
import type { MailboxSummary } from "./mailboxes";

/** The 5-minute poll should keep "last checked" fresh; past this, say so plainly. */
export const STALE_SYNC_MS = 30 * 60 * 1000;

export type HealthLine = { label: string; text: string; problem: boolean };
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
  } else if (!m.backfillCompletedAt) {
    checked = {
      label: "Last checked",
      text: "Reading your recent email for the first time.",
      problem: false,
    };
  } else if (!m.lastSyncedAt || now.getTime() - m.lastSyncedAt.getTime() > STALE_SYNC_MS) {
    checked = {
      label: "Last checked",
      text: `${m.lastSyncedAt ? relativeTime(m.lastSyncedAt, now) : "A while ago"}. That's longer than usual — we're looking into it. Nothing for you to do.`,
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
