/**
 * Pure follow-up rules (no database), shared by the scan (followups.ts), the drafter's re-check
 * and the sent screen (drafts.ts) and the Money card (money-rules.ts). SQL twins live next to
 * the scan's query.
 */
import { localDayStart } from "./growth-client-rules";

/** Don't chase anything the owner last wrote about more than this long ago. */
export const FOLLOWUP_MAX_AGE_DAYS = 21;

/**
 * Check 12 P1: the owner rules that may stand alone on an invoice and still let us chase it. The
 * amount rule ("Mentions more than $2,500.") is about deciding a price, which an invoice already
 * did. "model" rides along because the classifier is told to flag big amounts too.
 */
const AMOUNT_ONLY_HITS: readonly string[] = ["amount", "model"];

type NeedsOwnerFacts = {
  needsOwner: boolean;
  needsOwnerManual?: boolean | null;
  category: string | null;
  extracted: unknown;
  complainedAt?: Date | null;
};

/**
 * Check 12 P1: an invoice thread that needs the owner ONLY because it mentions more than the
 * money limit. The bigger the invoice, the more it should be chased, so this one still gets a
 * nudge (a draft, waiting for the owner's tap like every other). Never when the owner marked it
 * "This one needs me", nor with any complaint, dispute, legal, attack, payment-change or
 * "is this a bot" mark. Quotes keep the old rule: a big quote waits on the owner.
 */
export function amountOnlyNeedsOwner(t: NeedsOwnerFacts): boolean {
  if (!t.needsOwner || t.needsOwnerManual) return false;
  if (t.category !== "invoice_payment") return false;
  if (t.complainedAt != null) return false;
  const x = (t.extracted ?? {}) as {
    owner_rule_hits?: unknown;
    disputed?: unknown;
    injection?: unknown;
    payment_change?: unknown;
    asks_if_ai?: unknown;
  };
  if (x.disputed === true || x.injection === true) return false;
  if (x.payment_change === true || x.asks_if_ai === true) return false;
  const hits = Array.isArray(x.owner_rule_hits) ? (x.owner_rule_hits as unknown[]) : [];
  return hits.includes("amount") && hits.every((h) => AMOUNT_ONLY_HITS.includes(String(h)));
}

/** Check 12 P1: "needs you" stops a nudge, unless it's only an invoice's size. */
export function needsOwnerBlocksNudge(t: NeedsOwnerFacts): boolean {
  return (t.needsOwner || t.needsOwnerManual === true) && !amountOnlyNeedsOwner(t);
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Check 21 P2: a "wait until" further out than this is a model mistake, not a request. */
export const WAIT_UNTIL_MAX_DAYS = 366;

/** A real calendar date written YYYY-MM-DD, or null. */
export function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ISO_DATE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Check 21 P2: the follow-up signals of one sorted email, read loosely so a classify version
 * without them simply has none. `declines_quote` (they said no: hired someone else, holding off
 * indefinitely, don't need it) and `wait_until` (an ISO date they asked us to wait for: "after
 * the holidays", "next month"). A date in the past or more than a year out is dropped.
 * Content-free: a flag and a date.
 */
export function followupSignalsOf(
  m: { signals?: unknown; extracted?: unknown },
  now: Date,
): { declines_quote?: true; wait_until?: string } {
  const signals = (m.signals ?? {}) as { declines_quote?: unknown };
  const extracted = (m.extracted ?? {}) as { wait_until?: unknown };
  const out: { declines_quote?: true; wait_until?: string } = {};
  if (signals.declines_quote === true) out.declines_quote = true;
  const date = isoDateOrNull(extracted.wait_until);
  if (date) {
    const at = Date.parse(`${date}T00:00:00Z`);
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    if (at > today && at - today <= WAIT_UNTIL_MAX_DAYS * DAY_MS) out.wait_until = date;
  }
  return out;
}

/** Check 21 P2: `threads.nudge_after` for a `wait_until` date: that day's start in the owner's zone. */
export function nudgeAfterFor(waitUntil: string | undefined, timeZone: string): Date | null {
  const date = isoDateOrNull(waitUntil);
  return date ? localDayStart(date, timeZone) : null;
}

/** Check 21 P2: "Waiting until Jan 4, as they asked." — only while the date is still ahead. */
export function waitingLine(nudgeAfter: Date | null, now: Date, timeZone: string): string | null {
  if (!nudgeAfter || nudgeAfter.getTime() <= now.getTime()) return null;
  const day = nudgeAfter.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  });
  return `Waiting until ${day}, as they asked.`;
}
