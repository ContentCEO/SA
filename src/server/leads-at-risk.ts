import "server-only";
import { and, count, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  LEAD_AT_RISK_HOURS,
  LEAD_AT_RISK_MAX_AGE_HOURS,
  LEAD_AT_RISK_PUSHES_PER_DAY,
  type BusinessHours,
} from "@/config/business-hours";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { pushConfigured, sendPush, type PushSender } from "@/lib/web-push";
import { mailboxRunning } from "./mailbox-plan";
import { businessMinutesBetween, inBusinessHours, workHoursOf } from "./business-hours-rules";
import { notificationUrl, unalerted } from "./leads-at-risk-rules";
import { jobsAllowed } from "./lifecycle";
import { STALE_SYNC_MS } from "./mailbox-health";
import {
  claimPushSlot,
  pushEndpointsByWorkspace,
  releasePushSlot,
  recordPushResult,
} from "./push-alerts";
import { appUrl } from "@/lib/app-url";
import { sendSms, smsConfigured, TwilioError, type SmsSender } from "@/lib/sms";
import { queueCardIds, queueMembership } from "./drafts";
import {
  claimTextSlot,
  inQuietHours,
  releaseTextSlot,
  secondsUntilQuiet,
  SMS,
  stopTextsForOptOut,
  textsOn,
  textsSentToday,
} from "./sms-alerts";
import { recordSmsDelivery } from "./sms-deliveries";
import { atRiskTextBody } from "./sms-summary-rules";
import { atLocalHour, usableTimeZone } from "./snooze-rules";
import {
  asDate,
  lastOutSql,
  noReplySql,
  quoteRequestSql,
  waitingReplySql,
  waitingSinceSql,
  crewSql,
} from "./thread-sql";

export { unalerted } from "./leads-at-risk-rules";

/**
 * Plan #34: a quote request the customer has been waiting on for more than
 * LEAD_AT_RISK_HOURS of business time. Content-free: ids, priority and times only — never a
 * name, an address, a subject or an email's text.
 */
export type LeadAtRisk = {
  threadId: string;
  priority: string | null;
  /** The customer's first email since the owner last wrote to them. */
  waitingSince: Date;
  /** When we last pushed about this thread (any wait). */
  alertedAt: Date | null;
};

/**
 * The candidates, unexecuted, so a test can check its bound values (no Date may reach the
 * driver inside raw SQL: plan M8 A10). Every Date here sits on the right of a drizzle operator
 * with a column on the left, so drizzle encodes it.
 *
 * A lead waits when: it's sorted as a quote request, in the inbox, not won / lost / no answer,
 * not snoozed, the customer wrote last (within the last LEAD_AT_RISK_MAX_AGE_HOURS), and
 * nothing answered it — no email from the owner after it (a forward to the crew or a
 * supplier, and the crew's reply to it, are a side conversation: `sideEmailSql`), no reply
 * sent from the app since the wait began, and no send waiting out its undo window (the email
 * of a reply sent from the app only arrives with the next sync: A12). A needs-you thread still counts (a big job is still a
 * lead), and so does one with a draft waiting (a draft isn't an answer). The same goes for a
 * Gmail draft older sync stored as the owner's mail: `lastOutSql` ignores it (a sent draft is a
 * new message in Gmail), so an unsent draft never hides a lead, checked by Gmail or not.
 *
 * A draft the owner threw away (Discard here, or deleted in Gmail) is NOT an answer (A12 lists
 * what is): a wrong draft is often discarded by someone meaning to write their own later, and
 * that is exactly the lead that goes cold. It drops off the queue, so the push links to /quotes.
 *
 * A quote request the classifier later re-sorted still counts while the owner has never written
 * on it (a forward to the crew isn't writing): "Just checking you got my message?" is often
 * sorted as a question, at the very moment the lead is most at risk (the sticky
 * `quote_requested_at` mark, A11). Once the owner has written, only a thread still sorted as a
 * quote request re-arms — a "Thanks, I'll let you know" re-sorted after the owner's quote
 * isn't a waiting lead — and a re-sort to noise never counts.
 *
 * Left out: a mailbox we can't see clearly — lost access, paused, or not synced in the last 30
 * minutes — because we couldn't see the owner's replies either (A12); and a wait that began
 * with a no-reply sender (a lead platform's notice, answered on the platform: A13).
 */
export function leadsAtRiskQuery(workspaceId: string, now: Date) {
  // The same "the owner wrote" as Quotes' stages and the digest (`lastOutSql`): a lead
  // forwarded to the crew (Gmail keeps the forward in the conversation) is still waiting.
  const waitingSince = waitingSinceSql();
  // Where a reply would go (a website form's Reply-To, else the sender): a form lead from a
  // no-reply robot is still a person waiting (B1).
  const waitingSender = waitingReplySql();
  const answeredInApp = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and (
    (d.status in ('sent', 'edited_and_sent') and d.decided_at >= ${waitingSince})
    or (d.status = 'pending' and (d.send_after is not null or d.send_claimed_at is not null))
  ))`;
  return db()
    .select({
      threadId: threads.id,
      priority: threads.priority,
      waitingSince: sql<string | Date | null>`${waitingSince}`,
      alertedAt: threads.atRiskAlertedAt,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        mailboxRunning(),
        gte(mailboxes.lastSyncedAt, new Date(now.getTime() - STALE_SYNC_MS)),
        or(
          eq(threads.category, "quote_request"),
          and(quoteRequestSql(), ne(threads.category, "noise"), sql`${lastOutSql()} is null`),
        ),
        eq(threads.inInbox, true),
        isNull(threads.quoteOutcome),
        or(isNull(threads.snoozedUntil), lte(threads.snoozedUntil, now)),
        gt(threads.lastMessageAt, new Date(now.getTime() - LEAD_AT_RISK_MAX_AGE_HOURS * 3_600_000)),
        sql`${waitingSince} is not null`,
        sql`not ${noReplySql(waitingSender)}`,
        // Check 41 P6: the owner's own crew is never a lead.
        sql`not ${crewSql(workspaceId, waitingSender)}`,
        sql`not ${answeredInApp}`,
      ),
    );
}

/**
 * The leads at risk now, in the owner's time zone: emergencies first, then whoever has waited
 * longest. The 4 hours are business hours (a Friday-evening request isn't late on Sunday).
 */
export async function leadsAtRisk(
  workspaceId: string,
  now: Date,
  timeZone: string,
  given?: BusinessHours,
): Promise<LeadAtRisk[]> {
  const tz = usableTimeZone(timeZone);
  // Check 15 P8: the owner's own working days and hours, unless the caller already has them.
  const hours = given ?? (await workspaceHours(workspaceId));
  const rows = await leadsAtRiskQuery(workspaceId, now);
  const leads: LeadAtRisk[] = [];
  for (const r of rows) {
    const waitingSince = asDate(r.waitingSince);
    if (!waitingSince) continue;
    if (businessMinutesBetween(waitingSince, now, tz, hours) < LEAD_AT_RISK_HOURS * 60) continue;
    leads.push({
      threadId: r.threadId,
      priority: r.priority,
      waitingSince,
      alertedAt: r.alertedAt,
    });
  }
  const rank = (l: LeadAtRisk) => (l.priority === "high" ? 0 : 1);
  return leads.sort(
    (a, b) => rank(a) - rank(b) || a.waitingSince.getTime() - b.waitingSince.getTime(),
  );
}

/** Check 15 P8: the hours the owner set on Settings → Your business (or the default). */
export async function workspaceHours(workspaceId: string): Promise<BusinessHours> {
  const [p] = await db()
    .select({
      workDays: businessProfiles.workDays,
      workStartHour: businessProfiles.workStartHour,
      workEndHour: businessProfiles.workEndHour,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return workHoursOf(p);
}

/**
 * Every 15 minutes (the workspace-lifecycle job): one phone notification per owner when a
 * quote request has waited past the mark. Only inside business hours and outside quiet hours,
 * at most LEAD_AT_RISK_PUSHES_PER_DAY a local day, each lead once per wait, and never within
 * 10 minutes of any other push (the slot is shared with new-lead pushes and claimed before
 * sending). The push is empty; the phone fetches the counts. Read-only accounts get none.
 *
 * Plan #50: an owner who switched on "Waiting quote requests by text" also gets a counts-only
 * text at the same moment, for the same leads — the one episode mark covers both, so a lead is
 * never alerted twice. The text shares quiet hours, the 10-minute text slot and the ten texts a
 * day with the other texts; a refused text hands its slot back (as `alertOne`), and a STOP turns
 * every text off. When neither a phone nor the text took it, the marks are taken back.
 */
export async function sendLeadAtRiskPushes(
  now: Date = new Date(),
  deps: { push?: PushSender; send?: SmsSender; workspaceId?: string; hours?: BusinessHours } = {},
): Promise<{ sent: number; notConfigured?: true }> {
  const push = deps.push ?? sendPush;
  const send = deps.send ?? sendSms;
  const canPush = !!deps.push || pushConfigured();
  const canText = !!deps.send || smsConfigured();
  if (!canPush && !canText) return { sent: 0, notConfigured: true };
  const byWorkspace = canPush
    ? await pushEndpointsByWorkspace(deps.workspaceId)
    : new Map<string, string[]>();
  const texting = canText
    ? (
        await db()
          .select({ workspaceId: businessProfiles.workspaceId })
          .from(businessProfiles)
          .where(
            and(
              deps.workspaceId ? eq(businessProfiles.workspaceId, deps.workspaceId) : undefined,
              eq(businessProfiles.smsAtRiskEnabled, true),
              eq(businessProfiles.smsAlertsEnabled, true),
            ),
          )
      ).map((r) => r.workspaceId)
    : [];
  const ids = [...new Set([...byWorkspace.keys(), ...texting])];
  if (!ids.length) return { sent: 0 };

  const rows = await db()
    .select({ workspace: workspaces, profile: businessProfiles })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(inArray(workspaces.id, ids));

  let sent = 0;
  for (const { workspace: w, profile: p } of rows) {
    // One owner's trouble never stops the others (A29); the log names no content (A3).
    try {
      if (!jobsAllowed(w, now)) continue;
      const tz = usableTimeZone(p?.timeZone);
      // Check 15 P8: each owner's own working days and hours (the default before they edit).
      const hours = deps.hours ?? workHoursOf(p);
      if (!inBusinessHours(now, tz, hours) || inQuietHours(now, tz)) continue;

      const [today] = await db()
        .select({ n: count() })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.workspaceId, w.id),
            eq(activityLog.action, "lead_at_risk_push_sent"),
            gte(activityLog.createdAt, atLocalHour(now, tz, 0, 0)),
          ),
        );
      if ((today?.n ?? 0) >= LEAD_AT_RISK_PUSHES_PER_DAY) continue;

      const leads = (await leadsAtRisk(w.id, now, tz, hours)).filter(unalerted);
      if (!leads.length) continue;

      const phones = byWorkspace.get(w.id) ?? [];
      // Plan #50: may this alert also go by text (its switch, a confirmed number, no STOP,
      // under the ten a day, outside the 10-minute gap)?
      const textsToday =
        canText && p?.smsAtRiskEnabled && textsOn(p)
          ? await textsSentToday(w.id, now, tz)
          : SMS.dailyCap;
      const wantText = textsToday < SMS.dailyCap;

      // Claim the shared slots first so two runs (or a new-lead push / text) can't both go.
      const pushSlot = phones.length > 0 && (await claimPushSlot(w.id, now));
      const textSlot = wantText && (await claimTextSlot(w.id, now));
      const handBack = async () => {
        if (pushSlot) await releasePushSlot(w.id, now, p?.pushLastSentAt ?? null);
        if (textSlot) await releaseTextSlot(w.id, now, p?.smsLastSentAt ?? null);
      };
      if (!pushSlot && !textSlot) continue;

      // Mark each lead for this wait; a lead another run marked first isn't counted twice.
      const claimed: LeadAtRisk[] = [];
      for (const l of leads) {
        const marked = await db()
          .update(threads)
          .set({ atRiskAlertedAt: now })
          .where(
            and(
              eq(threads.id, l.threadId),
              or(isNull(threads.atRiskAlertedAt), lt(threads.atRiskAlertedAt, l.waitingSince)),
            ),
          )
          .returning({ id: threads.id });
        if (marked.length) claimed.push(l);
      }
      if (!claimed.length) {
        await handBack();
        continue;
      }

      // One phone's trouble never stops the others; a phone that's gone is forgotten.
      let delivered = 0;
      if (pushSlot)
        for (const endpoint of phones) {
          try {
            // Check 19 P8: the push service drops it rather than buzz after 9pm.
            const r = await push(endpoint, { ttlSec: secondsUntilQuiet(now, tz) });
            await recordPushResult(w.id, endpoint, r, now);
            if (r === "sent") delivered++;
          } catch (err) {
            console.error("lead_at_risk_push_failed", {
              workspaceId: w.id,
              error: err instanceof Error ? err.name : "unknown",
            });
          }
        }
      // A phone that never buzzed doesn't hold up the next new-lead push.
      if (pushSlot && !delivered) await releasePushSlot(w.id, now, p?.pushLastSentAt ?? null);

      const texted = textSlot
        ? await textAtRisk(w.id, p!, claimed, now, tz, send, textsToday)
        : null;

      // Nothing reached the owner: we didn't let them know, so take the marks back (the next
      // run may try again), write nothing to Activity and leave the day's allowance alone.
      if (!delivered && !texted) {
        await unmark(claimed, now);
        continue;
      }
      await db()
        .insert(activityLog)
        .values({
          workspaceId: w.id,
          actor: "squared_away",
          action: "lead_at_risk_push_sent",
          detail: {
            leads: claimed.length,
            phones: delivered,
            // Plan #50: counted toward the ten texts a day (sms-alerts `textsSentToday`).
            ...(texted
              ? { texted: true, ...(texted.deliveryId ? { deliveryId: texted.deliveryId } : {}) }
              : {}),
          },
          // The injected clock, so the local-day cap counts what this run wrote (A16).
          createdAt: now,
        });
      sent++;
    } catch (err) {
      console.error("lead_at_risk_push_failed", {
        workspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { sent };
}

/**
 * Plan #50: the waiting-quote text, once this run holds the text slot. Counts and a link only.
 * Null when it didn't go (refused, STOP, Twilio not set up): the slot is handed back then.
 */
async function textAtRisk(
  workspaceId: string,
  p: typeof businessProfiles.$inferSelect,
  leads: LeadAtRisk[],
  now: Date,
  tz: string,
  send: SmsSender,
  textsToday: number,
): Promise<{ deliveryId: string | null } | null> {
  const release = () => releaseTextSlot(workspaceId, now, p.smsLastSentAt);
  try {
    // Where a tap lands: the lead's card on the queue, else the quote list (plan M8 A26).
    const onQueue = queueCardIds(await queueMembership(workspaceId, now));
    const url = appUrl(
      notificationUrl({ atRisk: leads.map((l) => l.threadId), needsYou: [], onQueue }),
    );
    const r = await send({
      to: p.alertPhone!,
      body: atRiskTextBody(leads.length, url, { lastToday: textsToday + 1 >= SMS.dailyCap }),
      validitySec: secondsUntilQuiet(now, tz),
    });
    if (r === "not_configured") {
      await release();
      return null;
    }
    if (r === "opted_out") {
      await release();
      await stopTextsForOptOut(workspaceId, now);
      return null;
    }
    return { deliveryId: await recordSmsDelivery(workspaceId, r, "alert", now) };
  } catch (err) {
    await release();
    console.error("lead_at_risk_text_failed", {
      workspaceId,
      status: err instanceof TwilioError ? err.status : null,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/** Put back each lead's earlier mark, only where this run's mark is still the one stored. */
async function unmark(leads: LeadAtRisk[], now: Date) {
  for (const l of leads)
    await db()
      .update(threads)
      .set({ atRiskAlertedAt: l.alertedAt })
      .where(and(eq(threads.id, l.threadId), eq(threads.atRiskAlertedAt, now)));
}
