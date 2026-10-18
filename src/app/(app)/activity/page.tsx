import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  listActivityPage,
  lostReasonsBetween,
  localMonthName,
  monthCloseRate,
  monthMoney,
  monthSummary,
  moneySoFar,
} from "@/server/activity";
import {
  activityCursorParam,
  groupByDay,
  parseActivityCursor,
  MONEY_SO_FAR_NOTE,
  moneyIsEmpty,
  moneySoFarLines,
  tallyText,
} from "@/server/activity-rules";
import { weekScorecards } from "@/server/scorecard";
import {
  asWrittenSentence,
  quoteSpeedSentence,
  responseTimeSentence,
  scorecardIsEmpty,
  scorecardLines,
  timeSavedPhrase,
  timeSavedRule,
} from "@/server/scorecard-rules";
import { requireOwner } from "@/server/session";
import { lostReasonsSentence } from "@/server/quote-rules";
import { localMonthStart } from "@/server/snooze-rules";
import { accountLockReason } from "@/server/autopilot";
import { workspaceTimeZone } from "@/server/snooze";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage(props: PageProps<"/activity">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  // Check 14 P6: older pages of the log; a cursor that doesn't parse is the first page.
  const before = parseActivityCursor(params.before);
  const now = new Date();
  // One month for the whole screen, in the owner's own time zone.
  const timeZone = await workspaceTimeZone(workspace.id);
  const [{ entries, older }, month, close, weeks, money, soFar] = await Promise.all([
    listActivityPage(workspace.id, { before }),
    monthSummary(workspace.id, now, timeZone),
    monthCloseRate(workspace.id, now, timeZone),
    weekScorecards(workspace.id, now, timeZone),
    monthMoney(workspace.id, now, timeZone),
    moneySoFar(workspace.id, now, timeZone),
  ]);
  // Replies package: the morning email's money lines, word for word (totals only).
  const soFarLines = moneySoFarLines(soFar);
  const days = groupByDay(entries, now, timeZone);
  const { thisWeek, lastWeek } = weeks;
  const decided = close.won + close.lost + close.noAnswer;
  const monthName = localMonthName(now, timeZone);
  // Ideas C5: the owner's own reasons for lost quotes this month (fixed words and counts).
  const lostLine = lostReasonsSentence(
    await lostReasonsBetween(workspace.id, localMonthStart(now, timeZone), null),
  );
  // Ideas C8 / H8: counts and fixed words only.
  const speedLine = quoteSpeedSentence(thisWeek.speed, lastWeek.speed, "this week");
  const writtenLine = asWrittenSentence(thisWeek.asWritten, lastWeek.asWritten, "this week");
  // The autopilot link only where autopilot can be had (a plan with it, setup done).
  const autopilotOffered = accountLockReason(workspace, now) === null;

  return (
    <>
      <Headline serif="what got done," heavy="activity." />
      <Link
        href="/money"
        className={cn(buttonVariants({ variant: "outline" }), "min-h-tap self-start")}
      >
        Money owed →
      </Link>

      {/* Outside review K1: what was won and paid leads; time saved stays underneath. */}
      <section aria-labelledby="money" className="sa-inverted flex flex-col gap-3 rounded-xl p-4">
        <h2 id="money" className="text-lg font-black">
          Won and paid in {monthName}
        </h2>
        {soFarLines.map((line) => (
          <p key={line} className="text-lg font-semibold">
            {line}
          </p>
        ))}
        {moneyIsEmpty(money) ? (
          soFar.won.count === 0 && soFar.paid.count === 0 ? (
            <p className="text-lg">
              Nothing won or paid yet this month. Mark quotes Won on Quotes, and invoices paid on
              Money owed.
            </p>
          ) : null
        ) : (
          <dl className="flex flex-col gap-2">
            {[
              ["Quotes won", tallyText(money.won)],
              ["Invoices paid after a follow-up", tallyText(money.paidAfterNudge)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-sm text-ash">{label}</dt>
                <dd className="text-2xl font-black">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-sm text-ash">{MONEY_SO_FAR_NOTE}</p>
      </section>

      <section
        aria-labelledby="week"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="week" className="text-lg font-black">
          This week so far
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {(
            [
              // Check 14 P3: autopilot's sends are never "you sent"; the tiles add up to the
              // time saved (each × the rule's minutes).
              ["Replies you sent", thisWeek.repliesSent],
              ["Follow-ups sent", thisWeek.followupsSent],
              ...((thisWeek.autopilotSent ?? 0) > 0
                ? [["Autopilot sent", thisWeek.autopilotSent ?? 0]]
                : []),
              // Check 14 P4: any first answer, so not "quotes out".
              ["Quote requests answered", thisWeek.quotesOut],
              ["Time saved (estimate)", timeSavedPhrase(thisWeek.minutesSaved)],
            ] as [string, string | number][]
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-lg">{responseTimeSentence(thisWeek.response, lastWeek.response)}</p>
        {speedLine ? <p className="text-lg">{speedLine}</p> : null}
        {writtenLine ? <p className="text-lg">{writtenLine}</p> : null}
        <p>
          {scorecardIsEmpty(lastWeek)
            ? "Nothing sent last week."
            : scorecardLines(lastWeek, "Last week", { average: false, rule: false }).join(" ")}
        </p>
        {/* The rule once in this box (Check 14 P3); last week's line leaves it out. */}
        <p className="text-sm text-muted-foreground">
          {timeSavedRule()} Weeks start on Monday. Answered counts your first reply to each quote
          request, by email or by tapping I called them, in the week you answered. Response time
          runs from a customer&apos;s first email asking for a quote to your first reply. Clock
          time, nights and weekends included. The typical time is the middle one, so one slow answer
          can&apos;t drag it.
        </p>
        {speedLine ? (
          <p className="text-sm text-muted-foreground">
            Within 24 hours means 24 hours on the clock, from the customer&apos;s first email asking
            for a quote to your first reply. Nights and weekends count. A request still inside its
            first 24 hours isn&apos;t counted until you answer it or the 24 hours are up.
          </p>
        ) : null}
        {writtenLine ? (
          <p className="text-sm text-muted-foreground">
            Counts drafts you sent from the app. Filling in a blank like a price doesn&apos;t count
            against it. Replies autopilot sent, and drafts you sent from Gmail, aren&apos;t counted.
          </p>
        ) : null}
        {writtenLine && autopilotOffered ? (
          <Link
            href="/settings/autopilot"
            className="inline-flex min-h-tap items-center text-sm font-semibold underline underline-offset-4"
          >
            See which kinds of email are close to autopilot
          </Link>
        ) : null}
      </section>

      <section
        aria-labelledby="month"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="month" className="text-lg font-black">
          {monthName} so far
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {(
            [
              ["Emails sorted", month.sorted],
              ["Replies drafted", month.drafted],
              // Replies only, like the week's figure; follow-ups and autopilot have their own.
              ["Replies you sent", month.sent - month.nudgesSent - month.autopilotSent],
              ["Follow-ups sent", month.nudgesSent],
              ...(month.autopilotSent > 0 ? [["Autopilot sent", month.autopilotSent]] : []),
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-lg">
          <span className="font-black">Time saved: {timeSavedPhrase(month.minutesSaved)}.</span>{" "}
          <span className="text-muted-foreground">
            {timeSavedRule()}
            {month.sentAfterEditing
              ? ` ${month.sentAfterEditing} went out after you edited ${month.sentAfterEditing === 1 ? "it" : "them"}.`
              : ""}{" "}
            Sorting isn&apos;t counted.
          </span>
        </p>
      </section>

      <section aria-labelledby="close-rate" className="flex flex-col gap-3 rounded-xl border p-4">
        <h2 id="close-rate" className="text-lg font-black">
          Quotes decided this month
        </h2>
        {close.ratePct !== null ? (
          <>
            <p className="text-lg">
              {`You won ${close.won} of ${decided} quote${decided === 1 ? "" : "s"} decided this month (${close.ratePct}%).`}
            </p>
            <dl className="grid grid-cols-3 gap-3">
              {[
                ["Won", close.won],
                ["Lost", close.lost],
                ["No answer", close.noAnswer],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="text-2xl font-black">{value}</dd>
                </div>
              ))}
            </dl>
            {lostLine ? <p>{lostLine}</p> : null}
            <p className="text-sm text-muted-foreground">
              &ldquo;No answer&rdquo; and &ldquo;Won&rdquo; can be our guess — change any quote on
              Quotes.
            </p>
          </>
        ) : (
          <p className="text-lg">
            No quotes decided yet this month. Mark how they ended on Quotes.
          </p>
        )}
        <Link
          href="/quotes"
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          Go to Quotes
        </Link>
      </section>

      <section aria-labelledby="log" className="flex flex-col gap-3">
        <h2 id="log" className="text-xl font-black">
          What happened, newest first
        </h2>
        {entries.length === 0 ? (
          <p className="text-lg">
            {before
              ? "Nothing older."
              : "Nothing yet. Once your email is read, you'll see it here."}
          </p>
        ) : (
          days.map((day) => (
            <section
              key={day.key}
              aria-labelledby={`day-${day.key}`}
              className="flex flex-col gap-2"
            >
              <h3 id={`day-${day.key}`} className="font-black">
                {day.label}
              </h3>
              <ol className="flex flex-col divide-y rounded-xl border bg-card">
                {day.entries.map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
                    <span className={e.byYou ? "font-semibold" : undefined}>
                      {e.text}
                      {e.recordId ? (
                        <>
                          {" "}
                          <Link
                            href={`/record/${e.recordId}`}
                            className="inline-flex min-h-tap items-center font-semibold whitespace-nowrap underline underline-offset-4"
                          >
                            See record
                          </Link>
                        </>
                      ) : null}
                    </span>
                    <time
                      dateTime={e.at.toISOString()}
                      className="shrink-0 text-sm text-muted-foreground"
                    >
                      {day.label === "Today"
                        ? relativeTime(e.at, now)
                        : e.at.toLocaleTimeString("en-US", {
                            timeZone,
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
        {older ? (
          <Link
            href={`/activity?before=${encodeURIComponent(activityCursorParam(older))}#log`}
            className={cn(buttonVariants({ variant: "outline" }), "min-h-tap self-start")}
          >
            Show older
          </Link>
        ) : null}
      </section>
    </>
  );
}
