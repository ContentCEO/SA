/**
 * Check 15 P10: the summary line on Settings → Your Gmail. Pure. The check time is left to the
 * health list below it ("Last checked: …"), so it's said once.
 */
export function syncLine(
  m: { status: string; backfillCompletedAt: Date | null },
  messageCount: number,
  backfillDays: number,
): string {
  if (m.status === "reconnect_needed") {
    return "Google access was removed, so Squared Away has stopped reading this inbox. Reconnect to pick up where it left off.";
  }
  if (m.status === "paused") return "Paused. Nothing is being read or drafted.";
  if (!m.backfillCompletedAt) {
    return `Reading your last ${backfillDays} days of email. This can take a while.`;
  }
  const emails = messageCount === 1 ? "email" : "emails";
  return `${messageCount.toLocaleString("en-US")} ${emails} from the last ${backfillDays} days.`;
}
