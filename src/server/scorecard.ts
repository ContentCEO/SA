import "server-only";
import { and, count, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { MINUTES_PER_SENT_REPLY } from "@/config/drafting";
import { db } from "@/db";
import { drafts, mailboxes, threads } from "@/db/schema";
import { averageMinutes, quoteSpeed, weekBounds, type ScorecardNumbers } from "./scorecard-rules";
import {
  asDate,
  noReplySql,
  notDraftSql,
  quoteRequestSql,
  requestAtSql,
  requestReplySql,
  sideEmailSql,
} from "./thread-sql";

/**
 * Plan #32 weekly scorecard and #33 response time, in counts. Content-free: the queries
 * select only ids, kinds, counts and timestamps — never a name, an address, a subject or
 * an email's text. Scoped to one workspace through its mailboxes.
 */
export type Scorecard = ScorecardNumbers;

/** A Date for raw SQL: postgres.js can't bind a Date inside a sql`` template (A10). */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * When the owner first answered on the thread after `after` (a SQL timestamp), up to `now`:
 * the earliest of an email from the owner that sync brought in, a draft sent from the app
 * (when it was okayed), or a send waiting out its undo window (as leadsAtRisk, A12). A reply
 * sent from the app counts at once, before the next sync brings in its email. Forwarding the
 * request to the crew answers nobody (`sideEmailSql`, the same rule as leads at risk), but a
 * reply to a contact-form lead's Reply-To address does. So does the owner's "I called them"
 * (round 2, FW E11): the time they tapped it, the only record we have of the call.
 */
function firstAnswerSql(after: SQL, now: Date): SQL {
  const queued = sql`least(coalesce(d.send_after, d.send_claimed_at), ${at(now)})`;
  return sql`least(
    (select min(o.sent_at) from messages o where o.thread_id = ${threads.id} and o.direction = 'out' and ${notDraftSql("o")} and o.sent_at > ${after} and o.sent_at <= ${at(now)} and not ${sideEmailSql("o")}),
    (select min(d.decided_at) from drafts d where d.thread_id = ${threads.id} and d.status in ('sent', 'edited_and_sent') and d.decided_at > ${after} and d.decided_at <= ${at(now)}),
    (select min(${queued}) from drafts d where d.thread_id = ${threads.id} and d.status = 'pending' and (d.send_after is not null or d.send_claimed_at is not null) and ${queued} > ${after}),
    (case when ${threads.handledOfflineAt} > ${after} and ${threads.handledOfflineAt} <= ${at(now)} then ${threads.handledOfflineAt} end)
  )`;
}

/**
 * The three queries behind one week, unexecuted, so a test can check their bound values
 * (no Date may reach the driver: A10). Week = [start, end); replies are measured up to `now`.
 */
export function scorecardQueries(workspaceId: string, start: Date, end: Date, now: Date) {
  // Sent from the app, by when the owner okayed it. Drizzle encodes the Dates here (a
  // column is on the left of every comparison).
  const sent = db()
    .select({ kind: drafts.kind, n: count() })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        gte(drafts.decidedAt, start),
        lt(drafts.decidedAt, end),
      ),
    )
    .groupBy(drafts.kind);

  // When the quote was asked for (the sticky mark from classification; the thread's first
  // customer email on older threads), who asked, and the owner's first answer after it. A
  // request sent on an older conversation dates from the request, not the old chat.
  const requestedAt = requestAtSql();
  // Where a reply would go (a form's Reply-To, else the sender): B1.
  const requester = requestReplySql();
  const answer = firstAnswerSql(requestedAt, now);

  // Quotes out: each quote request once, in the week its quote went out — the owner's first
  // answer to the request. Not a nudge or later chat on a quote already out, and not a cold
  // email (nothing came in before it).
  const quotesOut = db()
    .select({ n: count() })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        quoteRequestSql(),
        sql`${answer} >= ${at(start)}`,
        sql`${answer} < ${at(end)}`,
      ),
    );

  // Response time: quote requests asked for this week (the week of the request), to the
  // owner's first answer after it, up to now. Calendar time. A no-reply sender (a lead
  // platform's notice) is answered on the platform, never here (A13).
  // `settled`: the owner marked how it ended (say, after a phone call) — handled, so never
  // "still waiting", though there's no email to time.
  const response = db()
    .select({
      firstIn: sql<string | Date | null>`${requestedAt}`,
      firstOut: sql<string | Date | null>`${answer}`,
      settled: sql<boolean>`(${threads.quoteOutcome} is not null and coalesce(${threads.quoteOutcomeSource}, 'owner') = 'owner')`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        quoteRequestSql(),
        sql`${requestedAt} >= ${at(start)}`,
        sql`${requestedAt} < ${at(end)}`,
        sql`not ${noReplySql(requester)}`,
        // Leads package: a lead website's or a phone message's request is answered off email,
        // so there's no email to time (it still counts as a quote request).
        sql`${threads.leadChannel} is null`,
      ),
    );

  // Ideas H8: drafts sent from the app this week, and how many went exactly as written. Only
  // sends we made (a Gmail message id we recorded: one reconcile marked "sent" from Gmail is
  // in neither number), never autopilot's. Filling a {{gap}} isn't a change, so a draft that
  // had gaps is left out of both (`hadGaps` recorded at send time; for older sends, the
  // draft's own text while it's still there — a purged one drops out rather than be guessed).
  const reply = sql`(select a.detail from activity_log a where a.workspace_id = ${workspaceId} and a.action = 'reply_sent' and a.detail->>'draftId' = ${drafts.id}::text order by a.created_at desc limit 1)`;
  const asWritten = db()
    .select({
      asWritten: sql<number>`count(*) filter (where ${drafts.status} = 'sent')::int`,
      counted: sql<number>`count(*)::int`,
    })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        inArray(drafts.kind, ["reply", "followup"]),
        gte(drafts.decidedAt, start),
        lt(drafts.decidedAt, end),
        sql`${drafts.sentGmailMessageId} is not null`,
        sql`coalesce(${reply}->>'autopilot', 'false') <> 'true'`,
        sql`(case when ${reply} ? 'hadGaps' then ${reply}->>'hadGaps' = 'false' else (${drafts.originalBody} is not null and ${drafts.originalBody} not like '%{{%') end)`,
      ),
    );

  return { sent, quotesOut, response, asWritten };
}

/** One week's numbers: [start, end), with replies to that week's requests counted up to now. */
export async function weeklyScorecard(
  workspaceId: string,
  start: Date,
  end: Date,
  now: Date = new Date(),
): Promise<Scorecard> {
  const q = scorecardQueries(workspaceId, start, end, now);
  const [sent, out, requests, written] = await Promise.all([
    q.sent,
    q.quotesOut,
    q.response,
    q.asWritten,
  ]);
  const sentOf = (kind: "reply" | "followup") => Number(sent.find((r) => r.kind === kind)?.n ?? 0);
  const repliesSent = sentOf("reply");
  const followupsSent = sentOf("followup");

  const pairs: { from: Date; to: Date }[] = [];
  const waiting: Date[] = [];
  let unanswered = 0;
  for (const r of requests) {
    const from = asDate(r.firstIn);
    const to = asDate(r.firstOut);
    if (from && to) pairs.push({ from, to });
    else if (!r.settled) {
      unanswered += 1;
      if (from) waiting.push(from);
    }
  }

  return {
    repliesSent,
    followupsSent,
    quotesOut: Number(out[0]?.n ?? 0),
    response: { avgMinutes: averageMinutes(pairs), answered: pairs.length, unanswered },
    // Same rule as the month: every drafted reply or follow-up the owner sent.
    minutesSaved: MINUTES_PER_SENT_REPLY * (repliesSent + followupsSent),
    // Ideas C8: within 24 hours, calendar time. Known edge: Monday's email counts last week
    // at send time, so a late-Sunday request still inside its first day is left out of it
    // (never marked slow early); the Activity card counts it once its 24 hours are up.
    speed: quoteSpeed(pairs, waiting, now),
    asWritten: {
      asWritten: Number(written[0]?.asWritten ?? 0),
      counted: Number(written[0]?.counted ?? 0),
    },
  };
}

/** This week so far and last week, in the owner's time zone (weeks start Monday 00:00). */
export async function weekScorecards(
  workspaceId: string,
  now: Date,
  timeZone: string,
): Promise<{ thisWeek: Scorecard; lastWeek: Scorecard; bounds: ReturnType<typeof weekBounds> }> {
  const bounds = weekBounds(now, timeZone);
  const [thisWeek, lastWeek] = await Promise.all([
    weeklyScorecard(workspaceId, bounds.start, bounds.end, now),
    weeklyScorecard(workspaceId, bounds.lastStart, bounds.start, now),
  ]);
  return { thisWeek, lastWeek, bounds };
}
