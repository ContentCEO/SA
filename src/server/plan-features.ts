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

/**
 * Check 42 P7: sign-ins per shop. One today on every plan (workspaces_owner_uq: one owner per
 * workspace); plans add Gmail inboxes, not people. Change this when team logins exist.
 */
export const SIGN_INS_PER_PLAN = 1;

/** Every plan does these. */
export const SHARED_PLAN_LINE = "Sorting, drafts, follow-ups, morning summary";

export function planFeatureLines(id: PlanId): string[] {
  const p = pricing.plans[id];
  const lines = [
    `${p.mailboxLimit} Gmail inbox${p.mailboxLimit === 1 ? "" : "es"} · ${SIGN_INS_PER_PLAN} sign-in${SIGN_INS_PER_PLAN === 1 ? "" : "s"}`,
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

/** "Crew and Company add more Gmail inboxes (3 or 10)": the plans with more than one inbox. */
export function moreInboxesLine(): string {
  const plans = Object.values(pricing.plans).filter((p) => p.mailboxLimit > 1);
  const join = (xs: string[], word: string) =>
    xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`;
  const names = join(
    plans.map((p) => p.name as string),
    "and",
  );
  const limits = join(
    plans.map((p) => String(p.mailboxLimit)),
    "or",
  );
  return `${names} add more Gmail inboxes (${limits})`;
}
