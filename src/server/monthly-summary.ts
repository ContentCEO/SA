import "server-only";
import { and, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { OTHER_JOB_KIND } from "@/config/job-kinds";
import { LEAD_SOURCES } from "@/config/lead-sources";
import type { Trade } from "@/config/trades";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  threads,
  users,
  workspaces,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendEmail, type EmailSender, emailErrorFields } from "@/lib/email";
import { closeRateBetween } from "./activity";
import { jobsAllowed } from "./lifecycle";
import {
  buildMonthlySummary,
  jobKindOf,
  jobKindsFor,
  leadSourceOf,
  monthlyDue,
  previousMonth,
  topCounts,
  type MonthlyStats,
} from "./monthly-rules";
import { localMonthName, usableTimeZone } from "./snooze-rules";
import {
  messageReplyAddress,
  noReplySql,
  quoteRequestSql,
  replyAddressSql,
  requestAtSql,
  requestSenderSql,
} from "./thread-sql";

/**
 * Plan #35: the first-of-month summary. Counts and OUR fixed labels only.
 *
 * Privacy (plan M8 A2): no customer address ever reaches this file's code. The lead source
 * is worked out from the sender's DOMAIN, cut out in SQL; repeat customers are one count in
 * SQL. The job described by the customer (model-extracted, so their words) is read only when
 * a thread has no stored kind yet, mapped straight onto a fixed label and dropped. Nothing
 * here is logged, stored or returned except labels and counts.
 */

/** A Date for raw SQL: postgres.js can't bind a Date inside a sql`` template (A10). */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** The outer thread's id, written qualified even inside a subquery on messages. */
const outerThreadId = () => sql`${threads.id}`;

/**
 * True when a sender's domain is one of the lead platforms (LEAD_SOURCES, same matching as
 * leadSourceOf: the domain itself, or a subdomain unless the entry is exact). A platform that
 * writes from a fixed address (leads@homeadvisor.com) on every lead is not a repeat customer.
 * Done in SQL, so no address reaches the app's code (A2).
 */
function leadPlatformSql(address: SQL) {
  const domain = sql`split_part(lower(trim(${address})), '@', 2)`;
  const tests: SQL[] = [];
  for (const source of LEAD_SOURCES) {
    for (const d of source.domains) {
      tests.push(sql`${domain} = ${d}`);
      if (!source.exact) tests.push(sql`right(${domain}, ${d.length + 1}) = ${`.${d}`}`);
    }
  }
  return sql`(${sql.join(tests, sql` or `)})`;
}

/** The labels a stored job kind may be for this trade (anything else is worked out again). */
function kindLabels(trade: Trade | null, extraTrades: readonly Trade[] = []): string[] {
  return [...new Set([...jobKindsFor(trade, extraTrades).map((k) => k.label), OTHER_JOB_KIND])];
}

/**
 * The two queries behind a month, unexecuted, so a test can check their bound values (no
 * Date may reach the driver: A10). Month = [start, end).
 */
export function monthlyStatsQueries(
  workspaceId: string,
  trade: Trade | null,
  start: Date,
  end: Date,
  extraTrades: readonly Trade[] = [],
) {
  // A quote request belongs to the month it was asked for (re-sorted threads still count,
  // A11; a new job asked for on an old conversation counts when it was asked for).
  const requestedAt = requestAtSql();
  // Only the domain of whoever asked, cut out in the database (A2).
  const requester = requestSenderSql();
  const firstDomain = sql<
    string | null
  >`(case when position('@' in ${requester}) > 0 then regexp_replace(lower(trim(${requester})), '^.*@', '') end)`;
  const requests = db()
    .select({
      jobKind: threads.jobKind,
      // The customer's words only when there's no usable stored label (older threads).
      service: sql<
        string | null
      >`case when ${threads.jobKind} is null or not (${inArray(threads.jobKind, kindLabels(trade, extraTrades))}) then left(${threads.extracted} ->> 'service_requested', 500) end`,
      domain: firstDomain,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        quoteRequestSql(),
        sql`${requestedAt} >= ${at(start)}`,
        sql`${requestedAt} < ${at(end)}`,
      ),
    );

  // Repeat customers: different addresses that wrote a NEW quote request or question this
  // month — a conversation that began this month, or a quote asked for this month — and had
  // written in before the month on ANOTHER thread. One conversation spanning the month's
  // start is not a repeat (A17), and neither is one job split over two September threads that
  // carries on in October. A no-reply sender or a lead platform's own address is a platform,
  // not a customer.
  const firstIn = sql`(select min(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in')`;
  const inMonth = (t: SQL) => sql`(${t} >= ${at(start)} and ${t} < ${at(end)})`;
  // One count, computed in the database: no address is returned.
  // By the address a reply goes to (B1): every lead through one website form shares its
  // robot From, and must not read as one customer writing again.
  const who = messageReplyAddress();
  const repeat = db()
    .select({ n: sql<number>`count(distinct ${who})` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
        gte(messages.sentAt, start),
        lt(messages.sentAt, end),
        or(quoteRequestSql(), eq(threads.category, "customer_question")),
        sql`(${inMonth(firstIn)} or ${inMonth(sql`${threads.quoteRequestedAt}`)})`,
        sql`position('@' in coalesce(${who}, '')) > 1`,
        sql`not ${noReplySql(who)}`,
        sql`not ${leadPlatformSql(who)}`,
        sql`exists (select 1 from messages e join mailboxes eb on eb.id = e.mailbox_id where eb.workspace_id = ${workspaceId} and e.direction = 'in' and e.thread_id <> ${messages.threadId} and ${replyAddressSql("e")} = ${who} and e.sent_at < ${at(start)})`,
      ),
    );

  return { requests, repeat };
}

/** One month in counts and fixed labels: exactly the MonthlyStats keys, nothing else. */
export async function monthlyStats(
  workspaceId: string,
  trade: Trade | null,
  start: Date,
  end: Date,
  extraTrades: readonly Trade[] = [],
): Promise<MonthlyStats> {
  const q = monthlyStatsQueries(workspaceId, trade, start, end, extraTrades);
  const [requests, repeat, rate] = await Promise.all([
    q.requests,
    q.repeat,
    closeRateBetween(workspaceId, start, end),
  ]);
  const allowed = new Set(kindLabels(trade, extraTrades));
  const kinds: string[] = [];
  const sources: string[] = [];
  for (const r of requests) {
    kinds.push(
      r.jobKind && allowed.has(r.jobKind) ? r.jobKind : jobKindOf(trade, r.service, extraTrades),
    );
    sources.push(leadSourceOf(r.domain));
  }
  return {
    quoteRequests: requests.length,
    jobKinds: topCounts(kinds, 3),
    leadSources: topCounts(sources, 3),
    repeatCustomers: Number(repeat[0]?.n ?? 0),
    won: rate.won,
    lost: rate.lost,
    noAnswer: rate.noAnswer,
    ratePct: rate.ratePct,
  };
}

export type MonthlyRun = { sent: number; skipped: number; failed: number; notConfigured: boolean };

/**
 * Hourly (with the morning summary): each owner's summary of the month just ended, once, on
 * their local 1st at or after their summary hour (or by the 3rd if the 1st was missed). It
 * follows the morning summary's on/off switch; read-only accounts get none; an empty month is
 * marked done without an email. Without email set up nothing is sent and nothing is marked.
 */
export async function sendMonthlySummaries(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<MonthlyRun> {
  const send = deps.send ?? sendEmail;
  const rows = await db()
    .select({
      workspace: workspaces,
      ownerEmail: users.email,
      profile: {
        digestEnabled: businessProfiles.digestEnabled,
        digestHour: businessProfiles.digestHour,
        timeZone: businessProfiles.timeZone,
        monthlySummaryLastSentFor: businessProfiles.monthlySummaryLastSentFor,
      },
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(
      sql`exists (select 1 from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaces.id})`,
    );

  const run: MonthlyRun = { sent: 0, skipped: 0, failed: 0, notConfigured: false };
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const timeZone = usableTimeZone(r.profile?.timeZone);
    const { due, monthKey } = monthlyDue(
      {
        digestEnabled: r.profile?.digestEnabled ?? true,
        digestHour: r.profile?.digestHour ?? 7,
        timeZone,
        monthlySummaryLastSentFor: r.profile?.monthlySummaryLastSentFor ?? null,
      },
      now,
    );
    if (!due) continue;

    try {
      const month = previousMonth(now, timeZone);
      const stats = await monthlyStats(
        r.workspace.id,
        r.workspace.trade,
        month.start,
        month.end,
        r.workspace.extraTrades ?? [],
      );
      const email = buildMonthlySummary(stats, localMonthName(month.start, timeZone), {
        activityUrl: appUrl("/activity"),
        settingsUrl: appUrl("/settings/morning-email"),
      });
      if (email.worthSending) {
        const outcome = await send({
          to: r.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
          idempotencyKey: `monthly-${r.workspace.id}-${monthKey}`,
        });
        if (outcome === "not_configured") {
          run.notConfigured = true;
          return run;
        }
        // "already_sent": the owner got this month's email on an earlier try whose marker
        // didn't save, and Resend refused a retry whose body had changed. Recorded as done.
      }
      // The month's marker and its Activity row go in together: a marker that fails to save
      // leaves no "Sent your monthly summary" behind, so the retry can't log it twice. Only the
      // run that moves the marker logs it (an overlapping run that found it set adds nothing).
      const marked = await db().transaction(async (tx) => {
        const [row] = await tx
          .insert(businessProfiles)
          .values({ workspaceId: r.workspace.id, monthlySummaryLastSentFor: monthKey })
          .onConflictDoUpdate({
            target: businessProfiles.workspaceId,
            set: { monthlySummaryLastSentFor: monthKey },
            setWhere: sql`${businessProfiles.monthlySummaryLastSentFor} is distinct from ${monthKey}`,
          })
          .returning({ workspaceId: businessProfiles.workspaceId });
        if (!row) return false;
        if (email.worthSending) {
          await tx.insert(activityLog).values({
            workspaceId: r.workspace.id,
            actor: "squared_away",
            action: "monthly_summary_sent",
            detail: {},
            createdAt: now,
          });
        }
        return true;
      });
      if (marked && email.worthSending) run.sent++;
      else run.skipped++;
    } catch (err) {
      // One account's trouble never stops the others; the next hourly run tries again
      // (nothing was marked). Metadata only (A3).
      run.failed++;
      console.error("monthly_summary_failed", {
        workspaceId: r.workspace.id,
        ...emailErrorFields(err),
      });
    }
  }
  return run;
}
