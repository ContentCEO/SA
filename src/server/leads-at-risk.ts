import "server-only";
import { and, count, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  BUSINESS_HOURS,
  LEAD_AT_RISK_HOURS,
  LEAD_AT_RISK_MAX_AGE_HOURS,
  LEAD_AT_RISK_PUSHES_PER_DAY,
  type BusinessHours,
} from "@/config/business-hours";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { pushConfigured, sendPush, type PushSender } from "@/lib/web-push";
import { mailboxRunning } from "./mailbox-plan";
import { businessMinutesBetween, inBusinessHours } from "./business-hours-rules";
import { unalerted } from "./leads-at-risk-rules";
import { jobsAllowed } from "./lifecycle";
import { STALE_SYNC_MS } from "./mailbox-health";
import {
  claimPushSlot,
  pushEndpointsByWorkspace,
  releasePushSlot,
  removePushSubscription,
} from "./push-alerts";
import { inQuietHours } from "./sms-alerts";
import { atLocalHour, usableTimeZone } from "./snooze-rules";
import {
  asDate,
  lastOutSql,
  noReplySql,
  quoteRequestSql,
  waitingReplySql,
  waitingSinceSql,
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
  hours: BusinessHours = BUSINESS_HOURS,
): Promise<LeadAtRisk[]> {
  const tz = usableTimeZone(timeZone);
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

/**
 * Every 15 minutes (the workspace-lifecycle job): one phone notification per owner when a
 * quote request has waited past the mark. Only inside business hours and outside quiet hours,
 * at most LEAD_AT_RISK_PUSHES_PER_DAY a local day, each lead once per wait, and never within
 * 10 minutes of any other push (the slot is shared with new-lead pushes and claimed before
 * sending). The push is empty; the phone fetches the counts. Read-only accounts get none.
 */
export async function sendLeadAtRiskPushes(
  now: Date = new Date(),
  deps: { push?: PushSender; workspaceId?: string; hours?: BusinessHours } = {},
): Promise<{ sent: number; notConfigured?: true }> {
  const push = deps.push ?? sendPush;
  if (!deps.push && !pushConfigured()) return { sent: 0, notConfigured: true };
  const hours = deps.hours ?? BUSINESS_HOURS;
  const byWorkspace = await pushEndpointsByWorkspace(deps.workspaceId);
  if (!byWorkspace.size) return { sent: 0 };

  const rows = await db()
    .select({
      workspace: workspaces,
      timeZone: businessProfiles.timeZone,
      lastPushAt: businessProfiles.pushLastSentAt,
    })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(inArray(workspaces.id, [...byWorkspace.keys()]));

  let sent = 0;
  for (const { workspace: w, timeZone, lastPushAt } of rows) {
    // One owner's trouble never stops the others (A29); the log names no content (A3).
    try {
      if (!jobsAllowed(w, now)) continue;
      const tz = usableTimeZone(timeZone);
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

      // Claim the shared slot first so two runs (or a new-lead push) can't both buzz.
      if (!(await claimPushSlot(w.id, now))) continue;

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
        await releasePushSlot(w.id, now, lastPushAt);
        continue;
      }

      // One phone's trouble never stops the others; a phone that's gone is forgotten.
      let delivered = 0;
      for (const endpoint of byWorkspace.get(w.id) ?? []) {
        try {
          const r = await push(endpoint);
          if (r === "gone") await removePushSubscription(w.id, endpoint);
          if (r === "sent") delivered++;
        } catch (err) {
          console.error("lead_at_risk_push_failed", {
            workspaceId: w.id,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      // Nothing reached a phone: we didn't let them know, so take the marks back (the next run
      // may try again), write nothing to Activity, leave the day's allowance alone and hand the
      // shared slot back, so a phone that never buzzed doesn't hold up the next new-lead push.
      if (!delivered) {
        await unmark(claimed, now);
        await releasePushSlot(w.id, now, lastPushAt);
        continue;
      }
      await db()
        .insert(activityLog)
        .values({
          workspaceId: w.id,
          actor: "squared_away",
          action: "lead_at_risk_push_sent",
          detail: { leads: claimed.length, phones: delivered },
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

/** Put back each lead's earlier mark, only where this run's mark is still the one stored. */
async function unmark(leads: LeadAtRisk[], now: Date) {
  for (const l of leads)
    await db()
      .update(threads)
      .set({ atRiskAlertedAt: l.alertedAt })
      .where(and(eq(threads.id, l.threadId), eq(threads.atRiskAlertedAt, now)));
}
