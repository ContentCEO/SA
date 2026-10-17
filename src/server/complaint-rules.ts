/**
 * Leads package (G5): the complaint playbook, as pure rules. Call first, fix it, mark it fixed,
 * and two days later check they're happy — once per fix. A legal threat keeps today's card.
 */
export const CHECKIN_AFTER_DAYS = 2;
/** A check-in nobody acted on goes away after this. */
export const CHECKIN_MAX_DAYS = 30;
const DAY = 86_400_000;

/** A complaint that isn't a legal threat (those stay the owner's own, as today). */
export function playbookApplies(t: { category: string | null; extracted: unknown }): boolean {
  const x = (t.extracted ?? {}) as {
    injection?: unknown;
    owner_rule_hits?: unknown;
    disputed?: unknown;
  };
  const hits = Array.isArray(x.owner_rule_hits) ? x.owner_rule_hits : null;
  // Sorted before rule hits were stored: a dispute or legal mark keeps today's card.
  const legal = hits ? hits.includes("legal") : x.disputed === true;
  return t.category === "complaint" && x.injection !== true && !legal;
}

/**
 * The check-in is due: fixed 2 to 30 days ago, not closed since that fix, and the customer
 * hasn't written since (a new email brings back the ordinary card instead).
 */
export function checkinDue(
  t: {
    complaintFixedAt: Date | null;
    complaintCheckinDoneAt: Date | null;
    lastInboundAt: Date | null;
  },
  now: Date,
): boolean {
  const fixed = t.complaintFixedAt;
  if (!fixed) return false;
  const age = now.getTime() - fixed.getTime();
  if (age < CHECKIN_AFTER_DAYS * DAY || age > CHECKIN_MAX_DAYS * DAY) return false;
  if (t.complaintCheckinDoneAt && t.complaintCheckinDoneAt >= fixed) return false;
  return !(t.lastInboundAt && t.lastInboundAt > fixed);
}
