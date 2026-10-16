import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { dailyAiCallCap } from "@/config/models";
import { db } from "@/db";
import { usage } from "@/db/schema";

export class AiCapReachedError extends Error {
  constructor(public readonly cap: number) {
    super(`Daily AI call cap reached (${cap}).`);
    this.name = "AiCapReachedError";
  }
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Count a call against today's cap *before* making it. Atomic, so parallel
 * jobs can't slip past the cap. Crossing 80% raises a one-time alert.
 */
export async function reserveAiCall(workspaceId: string, now: Date = new Date()): Promise<void> {
  const cap = dailyAiCallCap();
  const period = utcDay(now);
  const [row] = await db()
    .insert(usage)
    .values({ workspaceId, period, aiCalls: 1 })
    .onConflictDoUpdate({
      target: [usage.workspaceId, usage.period],
      set: { aiCalls: sql`${usage.aiCalls} + 1` },
    })
    .returning({ aiCalls: usage.aiCalls });
  const calls = row!.aiCalls;
  if (calls > cap) {
    // Nothing was called: give the slot back, so the count shows the cap, not past it.
    await refundAiCall(workspaceId, now);
    throw new AiCapReachedError(cap);
  }

  if (calls >= Math.ceil(cap * 0.8)) {
    const flagged = await db()
      .update(usage)
      .set({ capAlertedAt: now })
      .where(
        and(
          eq(usage.workspaceId, workspaceId),
          eq(usage.period, period),
          isNull(usage.capAlertedAt),
        ),
      )
      .returning({ period: usage.period });
    if (flagged.length > 0) {
      // Picked up by monitoring (Sentry in Milestone 11) and shown in /admin.
      console.warn("ai_cap_80_percent", { workspaceId, calls, cap, period });
    }
  }
}

/**
 * Give back a reserved call that never reached the model, or that the provider failed
 * (an outage, an overload, a timeout): an outage plus retries must not end an owner's
 * sorting and drafting for the day (review D5). Never below zero.
 */
export async function refundAiCall(workspaceId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(usage)
    .set({ aiCalls: sql`greatest(${usage.aiCalls} - 1, 0)` })
    .where(and(eq(usage.workspaceId, workspaceId), eq(usage.period, utcDay(now))));
}

/** Today's AI calls against the cap, for the owner's honest "limit reached" note (C6). */
export async function aiCallsToday(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ calls: number; cap: number }> {
  const [row] = await db()
    .select({ calls: usage.aiCalls })
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), eq(usage.period, utcDay(now))));
  return { calls: row?.calls ?? 0, cap: dailyAiCallCap() };
}

export async function recordAiUsage(
  workspaceId: string,
  u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costCentiCents: number;
  },
  now: Date = new Date(),
): Promise<void> {
  await db()
    .insert(usage)
    .values({
      workspaceId,
      period: utcDay(now),
      modelTokensIn: u.inputTokens,
      modelTokensOut: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      estimatedCostCentiCents: u.costCentiCents,
    })
    .onConflictDoUpdate({
      target: [usage.workspaceId, usage.period],
      set: {
        modelTokensIn: sql`${usage.modelTokensIn} + ${u.inputTokens}`,
        modelTokensOut: sql`${usage.modelTokensOut} + ${u.outputTokens}`,
        cacheReadTokens: sql`${usage.cacheReadTokens} + ${u.cacheReadTokens}`,
        cacheWriteTokens: sql`${usage.cacheWriteTokens} + ${u.cacheWriteTokens}`,
        estimatedCostCentiCents: sql`${usage.estimatedCostCentiCents} + ${u.costCentiCents}`,
      },
    });
}

/** Count drafts created / emails sent for the owner's activity and Davi's admin view. */
export async function bumpUsageCounter(
  workspaceId: string,
  field: "draftsCreated" | "emailsSent",
  now: Date = new Date(),
): Promise<void> {
  const column = field === "draftsCreated" ? usage.draftsCreated : usage.emailsSent;
  await db()
    .insert(usage)
    .values({ workspaceId, period: utcDay(now), [field]: 1 })
    .onConflictDoUpdate({
      target: [usage.workspaceId, usage.period],
      set: { [field]: sql`${column} + 1` },
    });
}
