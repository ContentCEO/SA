import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendSms, smsConfigured, type SmsSender } from "@/lib/sms";
import { pushConfigured, sendPush, type PushSender } from "@/lib/web-push";
import {
  dayStart,
  EMERGENCY_ALERTS,
  emergencyAlertable,
  emergencyAllowed,
  emergencySmsBody,
  emergencySummaryApplies,
  nightStart,
} from "./emergency-alert-rules";
import { queueDeepLink } from "./leads-at-risk-rules";
import { jobsAllowed } from "./lifecycle";
import { mailboxRunning } from "./mailbox-plan";
import { pushEndpointsByWorkspace, recordPushResult } from "./push-alerts";
import { usableTimeZone } from "./snooze-rules";
import {
  answeredByPhoneSql,
  asDate,
  lastInSql,
  lastOutSql,
  noReplySql,
  phoneMessageSenderSql,
  replyAddressSql,
  sideEmailSql,
} from "./thread-sql";

/**
 * Replies package (B5 part 2, Davi 2026-10-16: "yes", including at night): when sorting puts
 * a thread in the emergency lane — a burst pipe, no heat, sparks, a gas smell — the owner's
 * phone hears about it at once through the channels they switched on (phone notifications,
 * text alerts), quiet hours or not. Content-free: "An emergency email just came in." and a
 * link into the app. Never for read-only accounts, mailboxes that aren't on (lost access or
 * paused on the plan), email marked as trying to instruct the assistant, or a no-reply sender
 * (a voicemail / text-message email from a phone service excepted, 2026-10-17). Once per
 * thread, at most 3 a night (9pm–7am) and 6 a day; the owner can switch it off ("Emergencies,
 * even at night").
 */

/**
 * The emergencies waiting for an alert in one workspace: ids and the lane's marks only.
 * Every Date reaches raw SQL as an ISO string (plan M8 A10).
 *
 * A thread qualifies when it is in the inbox and needs the owner, in the emergency lane
 * (checked in code with the queue's own rule), never alerted before, not snoozed, and the
 * customer is still waiting: their newest email (a side conversation with the crew never
 * counts) is under an hour old, already sorted (so the mark is about THIS email, not an older
 * one), from someone a reply can reach (no no-reply sender, unless it is a voicemail or
 * text-message email from a phone service), and nothing answered it — no
 * owner email or "I called them" since, no reply sent from the app, none in its undo window.
 */
export async function emergencyCandidates(workspaceId: string, now: Date) {
  const fresh = new Date(now.getTime() - EMERGENCY_ALERTS.freshMs).toISOString();
  const newest = (col: string) =>
    sql`(select ${sql.raw(col)} from messages ei where ei.thread_id = ${threads.id} and ei.direction = 'in' and not ${sideEmailSql("ei")} order by ei.sent_at desc, ei.id desc limit 1)`;
  const newestReplyAddress = sql`(select ${replyAddressSql("er")} from messages er where er.thread_id = ${threads.id} and er.direction = 'in' and not ${sideEmailSql("er")} order by er.sent_at desc, er.id desc limit 1)`;
  const answeredInApp = sql`exists (select 1 from drafts ed where ed.thread_id = ${threads.id} and (
    (ed.status in ('sent', 'edited_and_sent') and ed.decided_at >= ${newest("ei.sent_at")})
    or (ed.status = 'pending' and (ed.send_after is not null or ed.send_claimed_at is not null))
  ))`;
  const rows = await db()
    .select({
      threadId: threads.id,
      category: threads.category,
      // Content-free marks only: never the email's facts.
      urgency: sql<string | null>`${threads.extracted}->>'urgency'`,
      injection: sql<string | null>`${threads.extracted}->>'injection'`,
      customerWroteAt: sql<string | Date | null>`${newest("ei.sent_at")}`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        // On = Google access works and the plan covers it (a plan-paused address never alerts).
        mailboxRunning(),
        eq(threads.inInbox, true),
        eq(threads.needsOwner, true),
        isNull(threads.emergencyAlertedAt),
        sql`${threads.extracted}->>'urgency' = 'emergency'`,
        sql`(${threads.extracted}->>'injection') is distinct from 'true'`,
        sql`${threads.classifiedAt} > ${fresh}::timestamptz`,
        or(isNull(threads.snoozedUntil), lte(threads.snoozedUntil, now)),
        sql`${newest("ei.sent_at")} > ${fresh}::timestamptz`,
        sql`${newest("ei.classified_at")} is not null`,
        // A no-reply sender never alerts, except a voicemail or text-message email (the
        // leads package's phone-message channel, e.g. Google Voice's voice-noreply@google.com):
        // in the emergency lane that is a caller who needs the owner. Integrator decision,
        // 2026-10-17. The alert still goes only to the owner's own phone; nothing is sent to
        // the caller (lead-channel threads are never drafted).
        sql`(not ${noReplySql(newestReplyAddress)} or ${phoneMessageSenderSql(newest("ei.from_address"))})`,
        sql`${lastInSql()} > coalesce(${lastOutSql()}, '-infinity'::timestamptz)`,
        sql`not ${answeredByPhoneSql()}`,
        sql`not ${answeredInApp}`,
      ),
    )
    .orderBy(desc(sql`${newest("ei.sent_at")}`));
  return rows
    .filter((r) =>
      emergencyAlertable({
        category: r.category,
        urgency: r.urgency,
        injection: r.injection === "true",
      }),
    )
    .map((r) => ({ threadId: r.threadId, customerWroteAt: asDate(r.customerWroteAt) }));
}

/** How many emergency alerts went out since `since` (the Activity rows are the record). */
async function alertsSince(
  q: Pick<ReturnType<typeof db>, "select">,
  workspaceId: string,
  since: Date,
) {
  const [row] = await q
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.workspaceId, workspaceId),
        eq(activityLog.action, "emergency_alert_sent"),
        gte(activityLog.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * After sorting, and every 15 minutes as a backstop: one alert per owner covering the
 * emergencies that just came in. The caps are counted, the threads marked and the Activity
 * row written under one lock per owner, so two runs at once can't both alert or pass a cap.
 * Nothing reached a phone → the marks and the row are taken back (the next run may try).
 *
 * Shared slot (plan #36 / #34): an emergency doesn't wait for the 10-minute gap between
 * pushes, but it takes the slot, so the next ordinary push waits 10 minutes after it; and
 * the ordinary new-lead alerts leave out an emergency already alerted (`freshLeads`).
 */
export async function sendEmergencyAlerts(
  now: Date = new Date(),
  deps: { push?: PushSender; send?: SmsSender; workspaceId?: string } = {},
): Promise<{ sent: number }> {
  const push = deps.push ?? sendPush;
  const send = deps.send ?? sendSms;
  const phonesBy =
    deps.push || pushConfigured()
      ? await pushEndpointsByWorkspace(deps.workspaceId)
      : new Map<string, string[]>();
  // Texting switched off for the app (no Twilio settings): nobody is texted, and an owner with
  // texts alone isn't claimed and handed back on every run.
  const canText = !!deps.send || smsConfigured();
  const texting = canText
    ? await db()
        .select({ workspaceId: businessProfiles.workspaceId })
        .from(businessProfiles)
        .where(
          and(
            deps.workspaceId ? eq(businessProfiles.workspaceId, deps.workspaceId) : undefined,
            eq(businessProfiles.smsAlertsEnabled, true),
            isNotNull(businessProfiles.alertPhoneVerifiedAt),
            isNotNull(businessProfiles.alertPhone),
          ),
        )
    : [];
  const ids = [...new Set([...phonesBy.keys(), ...texting.map((r) => r.workspaceId)])];
  if (!ids.length) return { sent: 0 };

  const rows = await db()
    .select({ workspace: workspaces, profile: businessProfiles })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(inArray(workspaces.id, ids));

  let sent = 0;
  for (const { workspace: w, profile: p } of rows) {
    // One owner's trouble never stops the others; the log names no content.
    try {
      if (!jobsAllowed(w, now)) continue;
      // On by default (the column defaults to true); the owner may switch it off.
      if (p && !p.emergencyAlertsEnabled) continue;
      const phones = phonesBy.get(w.id) ?? [];
      const smsTo =
        canText && p?.smsAlertsEnabled && p.alertPhoneVerifiedAt && p.alertPhone
          ? p.alertPhone
          : null;
      if (!phones.length && !smsTo) continue;

      const candidates = await emergencyCandidates(w.id, now);
      if (!candidates.length) continue;
      const tz = usableTimeZone(p?.timeZone);

      const reserved = await db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`emergency-alert:${w.id}`}))`);
        const night = nightStart(now, tz);
        const allowed = emergencyAllowed({
          sentToday: await alertsSince(tx, w.id, dayStart(now, tz)),
          sentTonight: night ? await alertsSince(tx, w.id, night) : 0,
          night: !!night,
        });
        if (!allowed) return null;
        // Once per thread: a thread another run marked first isn't alerted twice.
        const marked = await tx
          .update(threads)
          .set({ emergencyAlertedAt: now })
          .where(
            and(
              inArray(
                threads.id,
                candidates.map((c) => c.threadId),
              ),
              isNull(threads.emergencyAlertedAt),
            ),
          )
          .returning({ id: threads.id });
        if (!marked.length) return null;
        const [row] = await tx
          .insert(activityLog)
          .values({
            workspaceId: w.id,
            actor: "squared_away",
            action: "emergency_alert_sent",
            detail: { emergencies: marked.length },
            // The injected clock, so the caps count what this run wrote.
            createdAt: now,
          })
          .returning({ id: activityLog.id });
        const markedIds = new Set(marked.map((m) => m.id));
        return {
          threadIds: candidates.map((c) => c.threadId).filter((id) => markedIds.has(id)),
          activityId: row!.id,
        };
      });
      if (!reserved) continue;

      // One phone's trouble never stops the others; a phone that's gone is forgotten.
      let phonesReached = 0;
      for (const endpoint of phones) {
        try {
          const r = await push(endpoint);
          await recordPushResult(w.id, endpoint, r, now);
          if (r === "sent") phonesReached++;
        } catch (err) {
          console.error("emergency_push_failed", {
            workspaceId: w.id,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      let texted = false;
      if (smsTo) {
        try {
          const url = appUrl(queueDeepLink(reserved.threadIds[0]!));
          texted =
            (await send({ to: smsTo, body: emergencySmsBody(reserved.threadIds.length, url) })) ===
            "sent";
        } catch (err) {
          console.error("emergency_sms_failed", {
            workspaceId: w.id,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }

      if (!phonesReached && !texted) {
        // We didn't let them know: take the marks and the Activity row back.
        await db().delete(activityLog).where(eq(activityLog.id, reserved.activityId));
        await db()
          .update(threads)
          .set({ emergencyAlertedAt: null })
          .where(and(inArray(threads.id, reserved.threadIds), eq(threads.emergencyAlertedAt, now)));
        continue;
      }
      // Take the shared slots, so an ordinary alert waits its 10 minutes after this one.
      const slots = {
        ...(phonesReached ? { pushLastSentAt: now } : {}),
        ...(texted ? { smsLastSentAt: now } : {}),
      };
      await db()
        .insert(businessProfiles)
        .values({ workspaceId: w.id, ...slots })
        .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: slots });
      await db()
        .update(activityLog)
        .set({
          detail: { emergencies: reserved.threadIds.length, phones: phonesReached, text: texted },
        })
        .where(eq(activityLog.id, reserved.activityId));
      sent++;
    } catch (err) {
      console.error("emergency_alert_failed", {
        workspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { sent };
}

/**
 * For the phone's notification (`/api/push/summary`): the threads of the newest emergency
 * alert, newest first, when that alert is the last push that went out and under half an
 * hour old (`emergencySummaryApplies`). Ids only.
 */
export async function recentEmergencyAlert(
  workspaceId: string,
  now: Date,
): Promise<{ threadIds: string[]; at: Date } | null> {
  const since = new Date(now.getTime() - EMERGENCY_ALERTS.summaryWindowMs);
  const rows = await db()
    .select({ threadId: threads.id, at: threads.emergencyAlertedAt })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        gte(threads.emergencyAlertedAt, since),
        lte(threads.emergencyAlertedAt, now),
      ),
    )
    .orderBy(desc(threads.emergencyAlertedAt));
  const newest = rows[0]?.at;
  if (!newest) return null;
  return {
    at: newest,
    threadIds: rows.filter((r) => r.at?.getTime() === newest.getTime()).map((r) => r.threadId),
  };
}

/**
 * What `/api/push/summary` shows after an emergency push: the emergency's thread ids while
 * that alert is the last push that went out (and under half an hour old), else null.
 */
export async function emergencySummary(
  workspaceId: string,
  now: Date,
): Promise<{ threadIds: string[] } | null> {
  const recent = await recentEmergencyAlert(workspaceId, now);
  if (!recent) return null;
  const [p] = await db()
    .select({ lastPushAt: businessProfiles.pushLastSentAt })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return emergencySummaryApplies({
    newestEmergencyAlertAt: recent.at,
    lastPushAt: p?.lastPushAt ?? null,
    now,
  })
    ? { threadIds: recent.threadIds }
    : null;
}

/** The owner's "Emergencies, even at night" switch. Content-free Activity row. */
export async function setEmergencyAlerts(workspaceId: string, enabled: boolean) {
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, emergencyAlertsEnabled: enabled })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { emergencyAlertsEnabled: enabled },
    });
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "emergency_alerts_changed",
    detail: { enabled },
  });
}
