import "server-only";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { cache } from "react";
import {
  aiCallCapFor,
  aiCallCapMax,
  aiCallCapPerInbox,
  sortCallLimit,
  type AiPurpose,
} from "@/config/models";
import { db } from "@/db";
import { mailboxes, usage } from "@/db/schema";
import { mailboxRunning } from "@/server/mailbox-plan";
import type { EmailSender } from "@/lib/email";
import { notifyAdminOnce, withTimeoutMs } from "@/server/admin-notify";

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
 * Check 29 P5: this shop's daily limit, from its running inboxes (connected, Google access
 * working, not paused on the plan). One query, shared within a request (React cache).
 */
export const dailyAiCallCap = cache(async (workspaceId: string): Promise<number> => {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), mailboxRunning()));
  return aiCallCapFor(Number(row?.n ?? 0));
});

/**
 * The same limit as SQL, for lists over many shops (admin costs, the unsorted sweep).
 * `workspaceIdColumn` is a fully qualified column, e.g. `"usage"."workspace_id"`: written out,
 * since a bare name inside the subquery would mean the mailbox's own column.
 */
export function dailyAiCallCapSql(workspaceIdColumn: string): SQL<number> {
  return sql<number>`least(${sql.raw(String(aiCallCapMax()))}, ${sql.raw(String(aiCallCapPerInbox()))} * greatest(1, (select count(*) from mailboxes cap_m where cap_m.workspace_id = ${sql.raw(workspaceIdColumn)} and cap_m.status = 'active' and cap_m.plan_paused_at is null)))::int`;
}

/**
 * Count a call against today's cap *before* making it. Atomic, so parallel
 * jobs can't slip past the cap. Crossing 80% of the full cap raises a one-time alert.
 * Check 29 P4: a "sort" call is refused once the day's count passes sorting's share
 * (`sortCallLimit`), so drafts and voice keep the rest; every purpose stops at the cap.
 */
export async function reserveAiCall(
  workspaceId: string,
  now: Date = new Date(),
  purpose: AiPurpose = "other",
): Promise<void> {
  const cap = await dailyAiCallCap(workspaceId);
  const limit = purpose === "sort" ? sortCallLimit(cap) : cap;
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
  if (calls > limit) {
    // Nothing was called: give the slot back, so the count shows the cap, not past it.
    await refundAiCall(workspaceId, now);
    throw new AiCapReachedError(limit);
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
      // Check 1 P4: and an email to Davi, once per account per day (the flag above is set once).
      await notifyCapWarning(workspaceId, period, now);
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
  return { calls: row?.calls ?? 0, cap: await dailyAiCallCap(workspaceId) };
}

export async function recordAiUsage(
  workspaceId: string,
  u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costCentiCents: number;
    /** Check 48 P3: 1 when the role's approved stand-in model answered. */
    fallbackCalls?: number;
  },
  now: Date = new Date(),
): Promise<void> {
  const fallbackCalls = u.fallbackCalls ?? 0;
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
      fallbackCalls,
    })
    .onConflictDoUpdate({
      target: [usage.workspaceId, usage.period],
      set: {
        modelTokensIn: sql`${usage.modelTokensIn} + ${u.inputTokens}`,
        modelTokensOut: sql`${usage.modelTokensOut} + ${u.outputTokens}`,
        cacheReadTokens: sql`${usage.cacheReadTokens} + ${u.cacheReadTokens}`,
        cacheWriteTokens: sql`${usage.cacheWriteTokens} + ${u.cacheWriteTokens}`,
        estimatedCostCentiCents: sql`${usage.estimatedCostCentiCents} + ${u.costCentiCents}`,
        fallbackCalls: sql`${usage.fallbackCalls} + ${fallbackCalls}`,
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

/**
 * Check 1 P4: "An account used 80% of today's AI limit", content-free (no account named), with a
 * link to /admin. Once per account per day; never fails or holds up the model call.
 */
export async function notifyCapWarning(
  workspaceId: string,
  period: string,
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<void> {
  try {
    await withTimeoutMs(
      notifyAdminOnce(
        `ai_cap_80:${workspaceId}:${period}`,
        {
          subject: "An account used 80% of today's AI limit",
          serif: "heads up,",
          heavy: "an account is busy.",
          lines: [
            "An account used 80% of today's AI limit. When it reaches the limit, its sorting and drafting wait until tomorrow (UTC).",
            "See which one on the admin page (AI calls today).",
          ],
          path: "/admin",
        },
        { send: deps.send, now },
      ),
      5_000,
    );
  } catch (err) {
    console.error("ai_cap_notice_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
