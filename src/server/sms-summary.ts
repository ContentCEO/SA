import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, workspaces } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendSms, smsConfigured, TwilioError, type SmsSender } from "@/lib/sms";
import { digestCounts } from "./digest";
import { jobsAllowed } from "./lifecycle";
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
import { summaryTextBody, summaryTextDue } from "./sms-summary-rules";
import { localParts, usableTimeZone } from "./snooze-rules";

export type SummaryTextRun = {
  sent: number;
  /** Quiet mornings: nothing waiting, so no text (the day is marked done). */
  quiet: number;
  failed: number;
  notConfigured: boolean;
};

/**
 * Plan #50: the morning summary by text. Hourly, beside the morning email (same hour and time
 * zone, once a local day, before noon, never in quiet hours, never for read-only accounts), one
 * text with counts and a link — never a name, subject, amount or address. Its own switch,
 * independent of the email's. Shares the ten-a-day cap, the 10-minute gap and the delivery
 * records with the other texts. The day's marker is written only after Twilio accepted the text
 * (a quiet morning is marked without a text); without Twilio settings nothing is sent or marked.
 */
export async function sendSummaryTexts(
  now: Date = new Date(),
  deps: { send?: SmsSender; workspaceId?: string } = {},
): Promise<SummaryTextRun> {
  const run: SummaryTextRun = { sent: 0, quiet: 0, failed: 0, notConfigured: false };
  if (!deps.send && !smsConfigured()) return { ...run, notConfigured: true };
  const send = deps.send ?? sendSms;
  const rows = await db()
    .select({ workspace: workspaces, profile: businessProfiles })
    .from(businessProfiles)
    .innerJoin(workspaces, eq(workspaces.id, businessProfiles.workspaceId))
    .where(
      and(
        deps.workspaceId ? eq(businessProfiles.workspaceId, deps.workspaceId) : undefined,
        eq(businessProfiles.smsSummaryEnabled, true),
        eq(businessProfiles.smsAlertsEnabled, true),
        sql`exists (select 1 from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaces.id})`,
      ),
    );

  for (const { workspace: w, profile: p } of rows) {
    // One owner's trouble never stops the next owner's text; the log names no content.
    try {
      const r = await summaryOne(w, p, now, send);
      if (r === "not_configured") return { ...run, notConfigured: true };
      if (r === "sent") run.sent++;
      if (r === "quiet") run.quiet++;
    } catch (err) {
      run.failed++;
      console.error("sms_summary_failed", {
        workspaceId: w.id,
        status: err instanceof TwilioError ? err.status : null,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return run;
}

async function markDay(workspaceId: string, localDate: string): Promise<boolean> {
  const marked = await db()
    .update(businessProfiles)
    .set({ smsSummaryLastSentOn: localDate })
    .where(
      and(
        eq(businessProfiles.workspaceId, workspaceId),
        sql`${businessProfiles.smsSummaryLastSentOn} is distinct from ${localDate}`,
      ),
    )
    .returning({ id: businessProfiles.workspaceId });
  return marked.length > 0;
}

async function summaryOne(
  w: typeof workspaces.$inferSelect,
  p: typeof businessProfiles.$inferSelect,
  now: Date,
  send: SmsSender,
): Promise<"sent" | "quiet" | "skipped" | "not_configured" | "opted_out"> {
  if (!jobsAllowed(w, now)) return "skipped";
  if (!p.smsSummaryEnabled || !textsOn(p)) return "skipped";
  const tz = usableTimeZone(p.timeZone);
  const local = localParts(now, tz);
  if (!summaryTextDue({ digestHour: p.digestHour, lastSentOn: p.smsSummaryLastSentOn }, local))
    return "skipped";
  // A 5am or 6am morning-email hour: the text waits for 7am.
  if (inQuietHours(now, tz)) return "skipped";
  if (p.smsLastSentAt && now.getTime() - p.smsLastSentAt.getTime() < SMS.minGapMs) return "skipped";
  const sentToday = await textsSentToday(w.id, now, tz);
  if (sentToday >= SMS.dailyCap) return "skipped";

  // The morning email's own counts (the queue's content-free membership): numbers only.
  const c = await digestCounts(w.id, now, tz);
  const needsYou = c.needsYou.length + c.leadsAtRiskOffQueue + (c.notAnswered ?? 0);
  const onQueue = c.needsYou.length + c.repliesReady + c.nudgesReady + (c.notAnswered ?? 0);
  // A waiting lead with no card is on the quote list; everything else is on the queue.
  const url = appUrl(onQueue === 0 && c.leadsAtRiskOffQueue > 0 ? "/quotes" : "/queue");
  const body = summaryTextBody(
    { replies: c.repliesReady, followups: c.nudgesReady, needsYou },
    url,
    { lastToday: sentToday + 1 >= SMS.dailyCap },
  );
  if (!body) {
    // A quiet morning: no text, and the day is done (a later run won't text in the afternoon).
    await markDay(w.id, local.date);
    return "quiet";
  }

  // Claim the shared slot, and only while today isn't marked, so two runs can't both text.
  const claimed = await claimTextSlot(
    w.id,
    now,
    sql`${businessProfiles.smsSummaryLastSentOn} is distinct from ${local.date}`,
  );
  if (!claimed) return "skipped";

  let r: Awaited<ReturnType<SmsSender>>;
  try {
    r = await send({ to: p.alertPhone!, body, validitySec: secondsUntilQuiet(now, tz) });
  } catch (err) {
    // A refusal isn't a text: the slot goes back, the day stays unmarked (the next run tries).
    await releaseTextSlot(w.id, now, p.smsLastSentAt);
    throw err;
  }
  if (r === "not_configured") {
    await releaseTextSlot(w.id, now, p.smsLastSentAt);
    return "not_configured";
  }
  if (r === "opted_out") {
    await releaseTextSlot(w.id, now, p.smsLastSentAt);
    await stopTextsForOptOut(w.id, now);
    return "opted_out";
  }
  // Twilio accepted it: now the day is marked, and Activity says so (counts only).
  await markDay(w.id, local.date);
  const deliveryId = await recordSmsDelivery(w.id, r, "alert", now);
  await db()
    .insert(activityLog)
    .values({
      workspaceId: w.id,
      actor: "squared_away",
      action: "sms_summary_sent",
      detail: {
        replies: c.repliesReady,
        followups: c.nudgesReady,
        needsYou,
        ...(deliveryId ? { deliveryId } : {}),
      },
      createdAt: now,
    });
  return "sent";
}
