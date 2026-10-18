/**
 * Leads package (B5): the emergency lane, as pure rules. A burst pipe, no heat, sparks, a gas
 * smell: the model's `urgency: emergency` on an email from someone with a job (LEAD_CATEGORIES).
 * An email that tries to instruct the assistant never enters the lane.
 */
import { isLeadCategory } from "@/config/categories";

export const EMERGENCY_REASON = "Sounds like an emergency. Call them if you can.";

export function inEmergencyLane(t: { category: string | null; extracted: unknown }): boolean {
  const x = (t.extracted ?? {}) as { urgency?: unknown; injection?: unknown };
  return x.urgency === "emergency" && x.injection !== true && isLeadCategory(t.category);
}
