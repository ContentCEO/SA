import "server-only";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, smsDeliveries } from "@/db/schema";
import type { SmsSendResult } from "@/lib/sms";
import { ALL_TEXTS_OFF, statusRank, stopReasonFor } from "./sms-delivery-rules";

/** Check 19 P6: delivery reports are kept this long, then purged daily. */
export const SMS_DELIVERY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remember a text Twilio accepted, by its message id, so its delivery report can be matched.
 * No body, no number. Returns our row id (or null when there's nothing to match).
 */
export async function recordSmsDelivery(
  workspaceId: string,
  result: SmsSendResult,
  kind: "code" | "alert",
  now: Date = new Date(),
): Promise<string | null> {
  if (result === "not_configured" || result === "opted_out" || !result.sid) return null;
  const [row] = await db()
    .insert(smsDeliveries)
    .values({ workspaceId, messageSid: result.sid, kind, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: smsDeliveries.id });
  return row?.id ?? null;
}

/**
 * Twilio's report on one text (MessageStatus, ErrorCode). An earlier status arriving late
 * never overwrites a later one. A STOP (21610) or a number that can't take texts (30006)
 * switches texts off by themselves, with the reason the Text alerts screen shows.
 */
export async function applyTwilioStatus(
  messageSid: string,
  status: string,
  errorCode: number | null,
  now: Date = new Date(),
): Promise<"updated" | "unknown" | "stale"> {
  const [row] = await db()
    .select()
    .from(smsDeliveries)
    .where(eq(smsDeliveries.messageSid, messageSid));
  if (!row) return "unknown";
  if (statusRank(status) < statusRank(row.status)) return "stale";
  await db()
    .update(smsDeliveries)
    .set({ status, errorCode: errorCode ?? row.errorCode, updatedAt: now })
    .where(eq(smsDeliveries.id, row.id));
  const reason = stopReasonFor(errorCode);
  if (reason) {
    // Only an owner whose texts were on gets an Activity line, once (Twilio may report twice).
    const stopped = await db()
      .update(businessProfiles)
      // Plan #50: STOP turns every text off — new leads, the morning summary, waiting quotes.
      .set({ ...ALL_TEXTS_OFF, smsStoppedReason: reason })
      .where(
        and(
          eq(businessProfiles.workspaceId, row.workspaceId),
          eq(businessProfiles.smsAlertsEnabled, true),
        ),
      )
      .returning({ id: businessProfiles.workspaceId });
    // A code that couldn't arrive (texts not on yet): just the reason, for the screen.
    if (!stopped.length)
      await db()
        .update(businessProfiles)
        .set({ smsStoppedReason: reason })
        .where(eq(businessProfiles.workspaceId, row.workspaceId));
    if (stopped.length)
      await db()
        .insert(activityLog)
        .values({
          workspaceId: row.workspaceId,
          actor: "squared_away",
          action: "sms_alerts_changed",
          detail: { enabled: false, reason },
          createdAt: now,
        });
  }
  return "updated";
}

/** The newest text's report, for the Text alerts screen. */
export async function lastSmsDelivery(workspaceId: string) {
  const [row] = await db()
    .select({
      status: smsDeliveries.status,
      errorCode: smsDeliveries.errorCode,
      updatedAt: smsDeliveries.updatedAt,
      kind: smsDeliveries.kind,
    })
    .from(smsDeliveries)
    .where(eq(smsDeliveries.workspaceId, workspaceId))
    .orderBy(desc(smsDeliveries.createdAt))
    .limit(1);
  return row ?? null;
}

/** Each delivery row's status, by our id (Activity's text lines). */
export async function deliveryStatuses(workspaceId: string, ids: string[]) {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await db()
    .select({ id: smsDeliveries.id, status: smsDeliveries.status })
    .from(smsDeliveries)
    .where(and(eq(smsDeliveries.workspaceId, workspaceId), inArray(smsDeliveries.id, ids)));
  for (const r of rows) out.set(r.id, r.status);
  return out;
}

export async function purgeSmsDeliveries(now: Date = new Date()) {
  await db()
    .delete(smsDeliveries)
    .where(lt(smsDeliveries.createdAt, new Date(now.getTime() - SMS_DELIVERY_KEEP_MS)));
}
