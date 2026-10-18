import "server-only";
import { and, count, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, pushSubscriptions, workspaces } from "@/db/schema";
import { isPushEndpoint } from "@/lib/push-endpoint";
import { pushConfigured, sendPush, type PushResult, type PushSender } from "@/lib/web-push";
import { jobsAllowed } from "./lifecycle";
import { atRiskPushPart } from "./leads-at-risk-rules";
import {
  arrivedBeforeToday,
  freshLeads,
  inQuietHours,
  leadCounts,
  secondsUntilQuiet,
  SMS,
} from "./sms-alerts";
import { atLocalHour, usableTimeZone } from "./snooze-rules";

/**
 * Plan #36: a phone notification when new quote requests or emails that need
 * the owner arrive. Same rules as texts: quiet 9pm–7am, at least 10 minutes
 * apart, at most 10 a day, only fresh mail. The push itself is empty; the
 * phone fetches the counts (pushSummary) to show.
 */

/** Push services we deliver to. Anything else is refused at subscribe time (and by sendPush). */
export { isPushEndpoint };

export async function savePushSubscription(workspaceId: string, endpoint: string) {
  if (!isPushEndpoint(endpoint)) return false;
  await db()
    .insert(pushSubscriptions)
    .values({ workspaceId, endpoint })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { workspaceId } });
  return true;
}

/**
 * What the phone shows when a push arrives: counts only, never names or words. Quote
 * requests waiting past the at-risk mark (plan #34) come first. Replies are "ready to send"
 * only when this account can send; during the trial (or unpaid) they're "ready to check"
 * (round 2, FW).
 */
export function pushSummaryText(c: {
  replies: number;
  needsYou: number;
  atRisk?: number;
  /** Check 19 P1: fresh quote requests with no card on the queue yet (no draft). */
  newQuotes?: number;
  /** Check 19 P7: the oldest of those came in before the owner's midnight. */
  waiting?: boolean;
  canSend?: boolean;
}): string {
  const q = c.newQuotes ?? 0;
  const parts = [
    c.atRisk ? atRiskPushPart(c.atRisk) : null,
    q
      ? c.waiting
        ? `${q} quote request${q === 1 ? " is" : "s are"} waiting on you`
        : `${q} new quote request${q === 1 ? "" : "s"}`
      : null,
    c.needsYou
      ? `${c.needsYou} email${c.needsYou === 1 ? "" : "s"} need${c.needsYou === 1 ? "s" : ""} you`
      : null,
    c.replies
      ? `${c.replies} repl${c.replies === 1 ? "y" : "ies"} ready to ${c.canSend ? "send" : "check"}`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Your queue is up to date.";
}

/**
 * Check 19 P1: the fresh quote requests (ids only) a buzz may be about that have no queue card
 * — no reply drafted yet — from 24 hours before this owner's push cursor. The phone names
 * them and the tap opens Quotes.
 */
export async function newQuotesWithoutCard(
  workspaceId: string,
  onQueue: ReadonlySet<string>,
  now: Date,
  exclude: ReadonlySet<string> = new Set(),
): Promise<{ count: number; waiting: boolean }> {
  const [p] = await db()
    .select({ cursor: businessProfiles.pushAlertCursor, timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const from = new Date((p?.cursor ?? now).getTime() - 24 * 60 * 60 * 1000);
  const fresh = (await freshLeads(workspaceId, from, now)).filter(
    (t) =>
      !t.needsOwner &&
      t.category === "quote_request" &&
      !onQueue.has(t.threadId) &&
      !exclude.has(t.threadId),
  );
  return {
    count: fresh.length,
    // Check 19 P7: "waiting on you" when the oldest came in before the owner's midnight.
    waiting: arrivedBeforeToday(
      fresh.map((t) => t.lastMessageAt),
      now,
      p?.timeZone ?? "America/New_York",
    ),
  };
}

/**
 * Claim this owner's phone-notification slot, atomically: true for exactly one caller when no
 * push went out in the last 10 minutes. New-lead pushes (plan #36) and lead-at-risk pushes
 * (#34) share it, so the phone never buzzes twice inside the gap. `extra` is written with it.
 */
export async function claimPushSlot(
  workspaceId: string,
  now: Date,
  extra: Partial<{ pushAlertCursor: Date }> = {},
): Promise<boolean> {
  const set = { pushLastSentAt: now, ...extra };
  const claimed = await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set,
      setWhere: or(
        isNull(businessProfiles.pushLastSentAt),
        lt(businessProfiles.pushLastSentAt, new Date(now.getTime() - SMS.minGapMs)),
      ),
    })
    .returning({ id: businessProfiles.workspaceId });
  return claimed.length > 0;
}

/**
 * Hand back a slot claimed at `now` when nothing reached a phone: put the earlier time back,
 * only where this claim is still the one stored (a later claim is left alone). With
 * `previousCursor` (Check 19 P2), the new-lead cursor goes back too, so those leads buzz on
 * the next run.
 */
export async function releasePushSlot(
  workspaceId: string,
  now: Date,
  previous: Date | null,
  previousCursor?: Date | null,
) {
  await db()
    .update(businessProfiles)
    .set({
      pushLastSentAt: previous,
      ...(previousCursor !== undefined ? { pushAlertCursor: previousCursor } : {}),
    })
    .where(
      and(eq(businessProfiles.workspaceId, workspaceId), eq(businessProfiles.pushLastSentAt, now)),
    );
}

export async function removePushSubscription(workspaceId: string, endpoint: string) {
  await db()
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.workspaceId, workspaceId), eq(pushSubscriptions.endpoint, endpoint)),
    );
}

/** Check 19 P5: a phone whose push service has refused every push for this long is forgotten. */
export const PUSH_FAILING_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What one push's answer means for that phone's row (Check 19 P5): "gone" forgets it; "sent"
 * clears its failure count; "failed" (403 included — a changed key, a refusing service) counts
 * one more and forgets a phone that has failed for 7 days. Shared by every push sender.
 */
export async function recordPushResult(
  workspaceId: string,
  endpoint: string,
  result: PushResult,
  now: Date = new Date(),
) {
  const row = and(
    eq(pushSubscriptions.workspaceId, workspaceId),
    eq(pushSubscriptions.endpoint, endpoint),
  );
  if (result === "gone") return removePushSubscription(workspaceId, endpoint);
  if (result === "sent") {
    await db()
      .update(pushSubscriptions)
      .set({ failCount: 0, firstFailedAt: null })
      .where(and(row, gt(pushSubscriptions.failCount, 0)));
    return;
  }
  if (result !== "failed") return;
  const [r] = await db()
    .update(pushSubscriptions)
    .set({
      failCount: sql`${pushSubscriptions.failCount} + 1`,
      firstFailedAt: sql`coalesce(${pushSubscriptions.firstFailedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(row)
    .returning({ firstFailedAt: pushSubscriptions.firstFailedAt });
  if (r?.firstFailedAt && now.getTime() - r.firstFailedAt.getTime() >= PUSH_FAILING_FOR_MS)
    await removePushSubscription(workspaceId, endpoint);
}

/**
 * Check 19 P5: the browser renewed this phone's subscription (`pushsubscriptionchange`): the
 * new address takes the old one's place. Both must be real push services; the old row must be
 * this owner's (or gone already). False when refused.
 */
export async function replacePushSubscription(
  workspaceId: string,
  oldEndpoint: unknown,
  newEndpoint: unknown,
): Promise<boolean> {
  if (!isPushEndpoint(newEndpoint)) return false;
  if (oldEndpoint != null && !isPushEndpoint(oldEndpoint)) return false;
  if (typeof oldEndpoint === "string" && oldEndpoint !== newEndpoint)
    await removePushSubscription(workspaceId, oldEndpoint);
  return savePushSubscription(workspaceId, newEndpoint);
}

/** Each owner's phones (push endpoints), by workspace; one workspace when given. */
export async function pushEndpointsByWorkspace(workspaceId?: string) {
  const subs = await db()
    .select({ workspaceId: pushSubscriptions.workspaceId, endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(workspaceId ? eq(pushSubscriptions.workspaceId, workspaceId) : undefined);
  const byWorkspace = new Map<string, string[]>();
  for (const s of subs)
    byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s.endpoint]);
  return byWorkspace;
}

export async function sendPushAlerts(
  now: Date = new Date(),
  deps: { push?: PushSender; workspaceId?: string } = {},
) {
  const push = deps.push ?? sendPush;
  if (!deps.push && !pushConfigured()) return { sent: 0, notConfigured: true };
  const byWorkspace = await pushEndpointsByWorkspace(deps.workspaceId);
  if (!byWorkspace.size) return { sent: 0 };

  const rows = await db()
    .select({ workspace: workspaces, profile: businessProfiles })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(inArray(workspaces.id, [...byWorkspace.keys()]));

  let sent = 0;
  for (const { workspace: w, profile: p } of rows) {
    // Check 19 P2: one owner's trouble never stops the others; the log names no content.
    try {
      if (!jobsAllowed(w, now)) continue;
      if (inQuietHours(now, p?.timeZone ?? "America/New_York")) continue;
      const last = p?.pushLastSentAt ?? null;
      if (last && now.getTime() - last.getTime() < SMS.minGapMs) continue;
      const tz = usableTimeZone(p?.timeZone);
      // Check 19 P7: ten a local day, counted from the owner's midnight.
      const [today] = await db()
        .select({ n: count() })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.workspaceId, w.id),
            eq(activityLog.action, "push_alert_sent"),
            gte(activityLog.createdAt, atLocalHour(now, tz, 0, 0)),
          ),
        );
      if ((today?.n ?? 0) >= SMS.dailyCap) continue;

      const fresh = await freshLeads(w.id, p?.pushAlertCursor ?? null, now);
      if (!fresh.length) continue;

      // Claim the slot first so two runs can't both buzz the phone.
      const previousCursor = p?.pushAlertCursor ?? null;
      if (!(await claimPushSlot(w.id, now, { pushAlertCursor: fresh[0]!.classifiedAt! }))) continue;

      // One phone's trouble never stops the others; a phone that's gone is forgotten.
      let delivered = 0;
      for (const endpoint of byWorkspace.get(w.id) ?? []) {
        try {
          // Check 19 P8: the push service drops it rather than buzz after 9pm.
          const r = await push(endpoint, { ttlSec: secondsUntilQuiet(now, tz) });
          await recordPushResult(w.id, endpoint, r, now);
          if (r === "sent") delivered++;
        } catch (err) {
          console.error("push_alert_failed", {
            workspaceId: w.id,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      // Check 19 P2: nothing reached a phone, so we didn't let them know: hand the slot and the
      // cursor back (the next run tries again) and write nothing to Activity.
      if (!delivered) {
        await releasePushSlot(w.id, now, last, previousCursor);
        continue;
      }
      await db()
        .insert(activityLog)
        .values({
          workspaceId: w.id,
          actor: "squared_away",
          action: "push_alert_sent",
          detail: { ...leadCounts(fresh), phones: delivered },
          createdAt: now,
        });
      sent++;
    } catch (err) {
      console.error("push_alert_failed", {
        workspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { sent };
}
