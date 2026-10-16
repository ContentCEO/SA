import "server-only";
import type { Workspace } from "@/db/schema";
import { queueCounts, type QueueTotals } from "./drafts";
import { jobsAllowed } from "./lifecycle";

type Clocked = Pick<Workspace, "status" | "evaluationEndsAt">;

/**
 * Plan #38: the home-screen badge = replies ready to send + emails that need the owner, the
 * same numbers as the queue. A read-only account (evaluation over, past due, paused, canceled)
 * can't act on any of it, so its badge is 0 and clears (plan M8 A6).
 */
export function badgeCountOf(w: Clocked, totals: QueueTotals, now: Date = new Date()): number {
  if (!jobsAllowed(w, now)) return 0;
  return totals.drafts + totals.needsYou;
}

/**
 * The badge for one workspace, from the content-free queue counts (plan M8 A1/A32) — never
 * listQueue. A read-only account doesn't even run the count.
 */
export async function badgeCount(
  w: Clocked & Pick<Workspace, "id">,
  now: Date = new Date(),
): Promise<number> {
  if (!jobsAllowed(w, now)) return 0;
  return badgeCountOf(w, await queueCounts(w.id, now), now);
}
