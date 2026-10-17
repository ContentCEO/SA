/**
 * Leads package (B5): the emergency lane, as pure rules. A burst pipe, no heat, sparks, a gas
 * smell: the model's `urgency: emergency` on an email from someone with a job (LEAD_CATEGORIES).
 * An email that tries to instruct the assistant never enters the lane.
 */
import { isLeadCategory } from "@/config/categories";

export const EMERGENCY_REASON = "Sounds like an emergency — call them if you can.";

/**
 * Check 36 P2: an emergency keeps a mark on the thread for this long (`extracted.emergency` +
 * `emergency_at`), whatever later emails on it are sorted as. Autopilot and batch send read it,
 * so a "thanks, see you soon" re-sort can't let a reply go on its own the same day.
 */
export const EMERGENCY_STICKY_MS = 48 * 60 * 60 * 1000;

/** The thread had an emergency in the last 48 hours. Pure. */
export function recentEmergency(extracted: unknown, now: Date): boolean {
  const x = (extracted ?? {}) as { emergency?: unknown; emergency_at?: unknown };
  if (x.emergency !== true || typeof x.emergency_at !== "string") return false;
  const at = Date.parse(x.emergency_at);
  return Number.isFinite(at) && now.getTime() - at < EMERGENCY_STICKY_MS;
}

export function inEmergencyLane(t: { category: string | null; extracted: unknown }): boolean {
  const x = (t.extracted ?? {}) as { urgency?: unknown; injection?: unknown };
  return x.urgency === "emergency" && x.injection !== true && isLeadCategory(t.category);
}
