import "server-only";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  threads,
  users,
  workspaces,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendEmail, type EmailSender } from "@/lib/email";
import {
  moreInQueue,
  needsYouHeader,
  NOTHING_NEEDS_YOU,
  queueThreadUrl,
  toNeedsYouItem,
  type NeedsYouItem,
} from "./digest-rules";
import { queueMembership } from "./drafts";
import { jobsAllowed } from "./lifecycle";
import { weeklyScorecard } from "./scorecard";
import { scorecardIsEmpty, scorecardLines, weekBounds } from "./scorecard-rules";
import { localParts, localWeekday, usableTimeZone } from "./snooze-rules";

// Pure time helpers live in snooze-rules (so the *-rules files stay pure); re-exported here
// for the callers that always imported them from the digest.
export { localParts } from "./snooze-rules";

/** Due once a day, in the owner's chosen hour or any hour after it (so a missed run catches up). */
export function digestDue(
  s: {
    digestEnabled: boolean;
    digestHour: number;
    timeZone: string;
    digestLastSentOn: string | null;
  },
  now: Date,
): { due: boolean; localDate: string } {
  const { date, hour } = localParts(now, s.timeZone);
  return {
    due: s.digestEnabled && hour >= s.digestHour && s.digestLastSentOn !== date,
    localDate: date,
  };
}

export type DigestCounts = {
  repliesReady: number;
  nudgesReady: number;
  needsYou: NeedsYouItem[];
  sentYesterday: number;
  sortedYesterday: number;
};

/**
 * What the summary counts. Who is waiting comes from the queue's own content-free membership
 * (plan M8 A1), so the summary, the queue screen, phone notifications and the badge always
 * agree: snoozed items and replies in their undo window are left out exactly as the queue
 * leaves them out. Only ids, categories, priority and times are read here.
 */
export async function digestCounts(workspaceId: string, now: Date): Promise<DigestCounts> {
  const boxes = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (!boxes.length)
    return { repliesReady: 0, nudgesReady: 0, needsYou: [], sentYesterday: 0, sortedYesterday: 0 };
  const dayAgo = new Date(now.getTime() - 86_400_000);

  // Who is waiting, and since when (the customer's first email after the owner last wrote, A14).
  const q = await queueMembership(workspaceId, now);

  const [sent] = await db()
    .select({ n: count() })
    .from(drafts)
    .where(
      and(
        inArray(drafts.mailboxId, boxes),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        gte(drafts.decidedAt, dayAgo),
      ),
    );
  const [sorted] = await db()
    .select({ n: count() })
    .from(threads)
    .where(and(inArray(threads.mailboxId, boxes), gte(threads.classifiedAt, dayAgo)));

  return {
    repliesReady: q.drafts.filter((d) => d.kind === "reply").length,
    nudgesReady: q.drafts.filter((d) => d.kind === "followup").length,
    needsYou: q.needsYou.map(toNeedsYouItem),
    sentYesterday: sent?.n ?? 0,
    sortedYesterday: sorted?.n ?? 0,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type DigestLinks = {
  queueUrl: string;
  settingsUrl: string;
  /** A deep link to one card on the queue (`<queue>#t-<uuid>`). */
  threadUrl: (threadId: string) => string;
};

/**
 * The digest itself. Counts and categories only — no customer names, subjects
 * or email text — because this goes through an email provider, and email
 * content only ever goes to the AI provider. The detail is one tap away.
 *
 * It opens with "Needs you" (plan #31: up to three, each a link to its card), then what's
 * ready, then — on the owner's Monday — last week's numbers (plan #32), passed in as lines.
 */
export function buildDigest(
  c: DigestCounts,
  links: DigestLinks,
  extras: { now: Date; timeZone: string; lastWeek?: string[] },
) {
  const header = needsYouHeader(c.needsYou, extras.now, extras.timeZone, links.threadUrl);
  const lines = [
    c.repliesReady
      ? `${plural(c.repliesReady, "reply", "replies")} drafted and waiting for your okay.`
      : null,
    c.nudgesReady
      ? `${plural(c.nudgesReady, "follow-up")} ready for quiet quotes or invoices.`
      : null,
    c.sentYesterday || c.sortedYesterday
      ? `Yesterday: ${plural(c.sortedYesterday, "email")} sorted, ${plural(c.sentYesterday, "reply", "replies")} sent.`
      : null,
  ].filter((l): l is string => !!l);
  const lastWeek = extras.lastWeek ?? [];
  const waiting = c.needsYou.length + c.repliesReady + c.nudgesReady;
  const subject = waiting
    ? `${plural(waiting, "thing")} waiting on you`
    : "Nothing waiting on you this morning";

  const text = [
    "Good morning.",
    "",
    "Needs you:",
    ...(header.empty
      ? [NOTHING_NEEDS_YOU]
      : [
          ...header.lines.map((l) => `• ${l.text}: ${l.href}`),
          ...(header.more ? [moreInQueue(header.more)] : []),
        ]),
    ...(lines.length ? ["", ...lines] : []),
    ...(lastWeek.length ? ["", ...lastWeek] : []),
    "",
    ...(waiting ? [`Open your queue: ${links.queueUrl}`, ""] : []),
    `Nothing is sent without your okay. Change or turn off this email: ${links.settingsUrl}`,
    siteConfig.copyright,
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const para = (l: string) =>
    `<p style="margin:0 0 12px;font-size:17px;line-height:1.45">${esc(l)}</p>`;
  const needsHtml = header.empty
    ? para(NOTHING_NEEDS_YOU)
    : [
        ...header.lines.map(
          (l) =>
            `<p style="margin:0"><a href="${esc(l.href)}" style="display:block;padding:12px 0;color:#1b1b1b;font-size:17px;font-weight:700;line-height:1.35;text-decoration:underline">${esc(l.text)}</a></p>`,
        ),
        header.more
          ? `<p style="margin:0"><a href="${esc(links.queueUrl)}" style="display:block;padding:12px 0;color:#5e5d59;font-size:16px;line-height:1.35">${esc(moreInQueue(header.more))}</a></p>`
          : "",
      ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;color:#1b1b1b;font-family:Inter,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:24px 16px">
<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px">good morning,</p>
<p style="margin:0 0 20px;font-weight:900;font-size:30px;letter-spacing:-0.02em">${esc(waiting ? `${plural(waiting, "thing")} waiting.` : "all clear.")}</p>
<p style="margin:0 0 4px;font-weight:900;font-size:19px">Needs you</p>
${needsHtml}
<div style="margin:20px 0 0">
${lines.map(para).join("\n")}
</div>
${lastWeek.length ? `<div style="margin:20px 0 0;padding:16px 0 0;border-top:1px solid #1b1b1b">\n${lastWeek.map(para).join("\n")}\n</div>` : ""}
${
  waiting
    ? `<p style="margin:24px 0"><a href="${esc(links.queueUrl)}" style="display:inline-block;background:#1b1b1b;color:#efeeea;text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px">Open your queue</a></p>`
    : ""
}
<p style="margin:24px 0 4px;font-size:14px;color:#5e5d59">Nothing is sent without your okay. <a href="${esc(links.settingsUrl)}" style="color:#5e5d59">Change or turn off this email</a>.</p>
<p style="margin:0;font-size:14px;color:#5e5d59">${esc(siteConfig.copyright)}</p>
</div></body></html>`;

  // "Nothing needs you today." on its own doesn't make a quiet day worth an email.
  return {
    subject,
    text,
    html,
    worthSending: !header.empty || lines.length > 0 || lastWeek.length > 0,
  };
}

/**
 * Plan #32: on the owner's local Monday, last week's numbers (Monday 00:00 → Monday 00:00 in
 * their zone). Counts and fixed words only; nothing at all when the week was empty.
 */
export async function lastWeekLines(
  workspaceId: string,
  now: Date,
  timeZone: string,
): Promise<string[]> {
  if (localWeekday(now, timeZone) !== 1) return [];
  const bounds = weekBounds(now, timeZone);
  const lastWeek = await weeklyScorecard(workspaceId, bounds.lastStart, bounds.start, now);
  return scorecardIsEmpty(lastWeek) ? [] : scorecardLines(lastWeek, "Last week");
}

export type DigestRun = { sent: number; skipped: number; notConfigured: boolean };

/**
 * Hourly: send each owner their digest once a day at their hour. Quiet days
 * (nothing waiting, nothing happened) are skipped rather than sending noise.
 */
export async function sendDigests(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<DigestRun> {
  const send = deps.send ?? sendEmail;
  const rows = await db()
    .select({
      workspace: workspaces,
      ownerEmail: users.email,
      profile: {
        digestEnabled: businessProfiles.digestEnabled,
        digestHour: businessProfiles.digestHour,
        timeZone: businessProfiles.timeZone,
        digestLastSentOn: businessProfiles.digestLastSentOn,
      },
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(
      sql`exists (select 1 from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaces.id})`,
    );

  const run: DigestRun = { sent: 0, skipped: 0, notConfigured: false };
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const settings = {
      digestEnabled: r.profile?.digestEnabled ?? true,
      digestHour: r.profile?.digestHour ?? 7,
      timeZone: r.profile?.timeZone ?? "America/New_York",
      digestLastSentOn: r.profile?.digestLastSentOn ?? null,
    };
    const { due, localDate } = digestDue(settings, now);
    if (!due) continue;

    const timeZone = usableTimeZone(settings.timeZone);
    const queueUrl = appUrl("/queue");
    const digest = buildDigest(
      await digestCounts(r.workspace.id, now),
      {
        queueUrl,
        settingsUrl: appUrl("/settings#digest"),
        threadUrl: (id) => queueThreadUrl(queueUrl, id),
      },
      { now, timeZone, lastWeek: await lastWeekLines(r.workspace.id, now, timeZone) },
    );
    if (digest.worthSending) {
      const outcome = await send({
        to: r.ownerEmail,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
        idempotencyKey: `digest-${r.workspace.id}-${localDate}`,
      });
      if (outcome === "not_configured") {
        run.notConfigured = true;
        return run;
      }
      run.sent++;
      await db().insert(activityLog).values({
        workspaceId: r.workspace.id,
        actor: "squared_away",
        action: "digest_sent",
        detail: {},
      });
    } else {
      run.skipped++;
    }
    await db()
      .insert(businessProfiles)
      .values({ workspaceId: r.workspace.id, digestLastSentOn: localDate })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: { digestLastSentOn: localDate },
      });
  }
  return run;
}
