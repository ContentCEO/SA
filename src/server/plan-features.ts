import { pricing, type PlanId } from "@/config/pricing";

/**
 * Check 35 P4: what each plan includes, said the same way on the homepage cards and /billing,
 * chosen by plan id (never by display name) and built from src/config/pricing.ts. Pure: no
 * server-only, no db, so the public page can use it.
 */

/** The card drawn inverted (charcoal) on both pages. */
export const FEATURED_PLAN: PlanId = "crew";

/** Plans that come with priority support. What that means is Davi's call (Check 6). */
const PRIORITY_SUPPORT: readonly PlanId[] = ["company"];

/** Every plan does these. */
export const SHARED_PLAN_LINE = "Sorting, drafts, follow-ups, morning summary";

export function planFeatureLines(id: PlanId): string[] {
  const p = pricing.plans[id];
  const lines = [
    `${p.mailboxLimit} Gmail inbox${p.mailboxLimit === 1 ? "" : "es"}`,
    SHARED_PLAN_LINE,
  ];
  if (p.autopilot) lines.push("Autopilot for the emails you choose");
  if (PRIORITY_SUPPORT.includes(id)) lines.push("Priority support");
  return lines;
}

/** "Crew and Company": the plans with autopilot, in the config's order. */
export function autopilotPlanNames(): string {
  const names = Object.values(pricing.plans)
    .filter((p) => p.autopilot)
    .map((p) => p.name as string);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
