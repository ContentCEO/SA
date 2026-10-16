import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  listActivity,
  MINUTES_PER_SENT_REPLY,
  localMonthName,
  monthCloseRate,
  monthMoney,
  monthSummary,
} from "@/server/activity";
import { groupByDay, moneyIsEmpty, tallyText } from "@/server/activity-rules";
import { weekScorecards } from "@/server/scorecard";
import {
  responseTimeSentence,
  scorecardIsEmpty,
  scorecardLines,
  timeSavedPhrase,
} from "@/server/scorecard-rules";
import { requireOwner } from "@/server/session";
import { workspaceTimeZone } from "@/server/snooze";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  const { workspace } = await requireOwner();
  const now = new Date();
  // One month for the whole screen, in the owner's own time zone.
  const timeZone = await workspaceTimeZone(workspace.id);
  const [entries, month, close, weeks, money] = await Promise.all([
    listActivity(workspace.id),
    monthSummary(workspace.id, now, timeZone),
    monthCloseRate(workspace.id, now, timeZone),
    weekScorecards(workspace.id, now, timeZone),
    monthMoney(workspace.id, now, timeZone),
  ]);
  const days = groupByDay(entries, now, timeZone);
  const { thisWeek, lastWeek } = weeks;
  const decided = close.won + close.lost + close.noAnswer;
  const monthName = localMonthName(now, timeZone);

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
        {moneyIsEmpty(money) ? (
          <p className="text-lg">
            Nothing won or paid yet this month. Mark quotes Won on Quotes, and invoices paid on
            Money owed.
          </p>
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
        <p className="text-sm text-ash">
          From your own quotes and the invoices on Money owed. Won and paid can be our guess — check
          Quotes and Money owed.
        </p>
      </section>

      <section
        aria-labelledby="week"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="week" className="text-lg font-black">
          This week so far
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {[
            ["Replies sent", thisWeek.repliesSent],
            ["Follow-ups sent", thisWeek.followupsSent],
            ["Quotes out", thisWeek.quotesOut],
            ["Time saved (estimate)", timeSavedPhrase(thisWeek.minutesSaved)],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-lg">{responseTimeSentence(thisWeek.response, lastWeek.response)}</p>
        <p>
          {scorecardIsEmpty(lastWeek)
            ? "Nothing sent last week."
            : scorecardLines(lastWeek, "Last week", { average: false }).join(" ")}
        </p>
        <p className="text-sm text-muted-foreground">
          That&apos;s an estimate: {MINUTES_PER_SENT_REPLY} minutes for each drafted reply you sent.
          Weeks start on Monday. Response time runs from a customer&apos;s first email asking for a
          quote to your first reply.
        </p>
      </section>

      <section
        aria-labelledby="month"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="month" className="text-lg font-black">
          {monthName} so far
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {[
            ["Emails sorted", month.sorted],
            ["Replies drafted", month.drafted],
            // Replies only, like the week's figure; follow-ups have their own line.
            ["Replies you sent", month.sent - month.nudgesSent],
            ["Follow-ups sent", month.nudgesSent],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-lg">
          <span className="font-black">Time saved: {timeSavedPhrase(month.minutesSaved)}.</span>{" "}
          <span className="text-muted-foreground">
            That&apos;s an estimate: {MINUTES_PER_SENT_REPLY} minutes for each drafted reply you
            sent{month.sentAfterEditing ? ` (${month.sentAfterEditing} after editing)` : ""}.
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
          Everything, newest first
        </h2>
        {entries.length === 0 ? (
          <p className="text-lg">Nothing yet. Once your email is read, you&apos;ll see it here.</p>
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
      </section>
    </>
  );
}
