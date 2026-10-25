/**
 * A lower plan pauses extra Gmail addresses (Davi, 2026-10-16: "yes", and the owner picks which).
 * Pure rules; the database side is `mailbox-plan.ts`.
 *
 * The plan covers N addresses. When more are connected, exactly N stay on and the rest are
 * paused (`mailboxes.plan_paused_at`): nothing is read, sorted, drafted, sent, alerted or learned
 * from a paused address, and nothing in it is deleted. By default the oldest-connected stay on;
 * the owner can swap with "Use this one instead". A higher plan (or a disconnect) turns paused
 * ones back on, oldest first, up to the limit.
 */

/** What the owner sees wherever a paused address's draft would send (and the server answers). */
export const MAILBOX_PAUSED_LINE = "This Gmail address is paused on your plan.";

/**
 * Before a plan is chosen (the trial), a workspace gets one mailbox. One definition, in
 * pricing.ts (the referral merge found two); callers pass the plan that counts
 * (`effectivePlan`), so a free referral month's higher plan covers more addresses.
 */
export { mailboxLimitFor } from "@/config/pricing";

/** "Paused: your plan covers 1 Gmail address." — Settings → Your Gmail. */
export function planPausedLine(limit: number): string {
  return `Paused: your plan covers ${limit} Gmail address${limit === 1 ? "" : "es"}.`;
}

/** On = Google access works AND the plan covers it. Every job and send asks this. */
export function mailboxOn(m: { status: string; planPausedAt: Date | null }): boolean {
  return m.status === "active" && m.planPausedAt == null;
}

export type PlanBox = { id: string; createdAt: Date; planPausedAt: Date | null };

const oldestFirst = (a: PlanBox, b: PlanBox) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * Which addresses to pause and which to turn back on so that exactly min(limit, connected) are
 * on. The owner's earlier choice is kept: only the newest of those already on are paused when
 * there are too many, and only the oldest paused come back when there's room.
 */
export function fitToPlan(boxes: PlanBox[], limit: number): { pause: string[]; unpause: string[] } {
  const cap = Math.max(0, Math.floor(limit));
  const on = boxes.filter((b) => b.planPausedAt == null).sort(oldestFirst);
  const paused = boxes.filter((b) => b.planPausedAt != null).sort(oldestFirst);
  if (on.length > cap) return { pause: on.slice(cap).map((b) => b.id), unpause: [] };
  return { pause: [], unpause: paused.slice(0, cap - on.length).map((b) => b.id) };
}
