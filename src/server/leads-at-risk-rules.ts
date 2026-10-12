/**
 * Plan #34 leads at risk, as pure rules: when a waiting lead may be pushed about again, the
 * words a phone or the morning summary shows (counts only), and where a notification tap
 * opens. No names, subjects or addresses ever reach these: only counts and thread ids.
 */
import { LEAD_AT_RISK_HOURS } from "@/config/business-hours";

/**
 * Once per waiting episode: a lead is pushed about once while the customer waits. When the
 * owner answers and the customer writes again, the new wait starts after the old alert, so it
 * may be pushed about again.
 */
export function unalerted(l: { waitingSince: Date; alertedAt: Date | null }): boolean {
  return !l.alertedAt || l.alertedAt.getTime() < l.waitingSince.getTime();
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The phone's line: "2 quote requests have waited over 4 hours". */
export function atRiskPushPart(n: number): string {
  return `${n} quote ${plural(n, "request has", "requests have")} waited over ${LEAD_AT_RISK_HOURS} hours`;
}

/** The morning summary's line: "2 quote requests have waited more than 4 hours." */
export function atRiskDigestLine(n: number): string | null {
  if (n <= 0) return null;
  return `${n} quote ${plural(n, "request has", "requests have")} waited more than ${LEAD_AT_RISK_HOURS} hours.`;
}

/**
 * The morning summary's "Needs you" line for leads at risk with no card on the queue (no
 * draft waiting): "1 quote request waiting with no reply drafted — see your quotes".
 */
export function atRiskOffQueueLine(n: number): string {
  return `${n} quote ${plural(n, "request", "requests")} waiting with no reply drafted — see your quotes`;
}

/** Activity: "Let you know 2 quote requests were waiting". */
export function atRiskActivityLine(leads: unknown): string {
  const n = typeof leads === "number" && Number.isInteger(leads) && leads > 1 ? leads : 1;
  return n === 1
    ? "Let you know a quote request was waiting"
    : `Let you know ${n} quote requests were waiting`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A notification's link to one card: `/queue?t=<uuid>#t-<uuid>`. The query makes the tap a
 * real page load (an open queue would otherwise only jump to the hash and stay stale, without
 * the new card); the hash scrolls to the card. Anything but a uuid → the queue.
 */
export function queueDeepLink(threadId: string): string {
  if (!UUID.test(threadId)) return "/queue";
  const id = threadId.toLowerCase();
  return `/queue?t=${id}#t-${id}`;
}

/**
 * Every link a notification may open. The service worker (public/sw.js `safeUrl`) keeps the
 * same list and sends anything else to plain /queue.
 */
export function isNotificationUrl(u: unknown): boolean {
  if (u === "/queue" || u === "/quotes") return true;
  if (typeof u !== "string") return false;
  const m = /^\/queue\?t=([0-9a-f-]{36})#t-([0-9a-f-]{36})$/i.exec(u);
  return !!m && m[1] === m[2] && UUID.test(m[1]!);
}

/**
 * Where a tap on the phone notification goes (plan M8 A26): the first lead at risk if its card
 * is on the queue; else the quote tracker (it lists that lead as waiting on you); else the
 * first needs-you card on the queue; else the queue.
 */
export function notificationUrl(p: {
  atRisk: string[];
  needsYou: string[];
  onQueue: ReadonlySet<string>;
}): string {
  const lead = p.atRisk.find((id) => p.onQueue.has(id));
  if (lead) return queueDeepLink(lead);
  if (p.atRisk.length) return "/quotes";
  const needs = p.needsYou.find((id) => p.onQueue.has(id));
  return needs ? queueDeepLink(needs) : "/queue";
}
