import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  listActivity,
  MINUTES_PER_SENT_REPLY,
  monthCloseRate,
  monthSummary,
} from "@/server/activity";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: "Activity" };

function timeSaved(minutes: number) {
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

export default async function ActivityPage() {
  const { workspace } = await requireOwner();
  const now = new Date();
  const [entries, month, close] = await Promise.all([
    listActivity(workspace.id),
    monthSummary(workspace.id, now),
    monthCloseRate(workspace.id, now),
  ]);
  const decided = close.won + close.lost + close.noAnswer;
  const monthName = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  return (
    <>
      <Headline serif="what got done," heavy="activity." />
      <Link
        href="/money"
        className={cn(buttonVariants({ variant: "outline" }), "min-h-tap self-start")}
      >
        Money owed →
      </Link>

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
            ["Replies you sent", month.sent],
            ["Follow-ups sent", month.nudgesSent],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-lg">
          <span className="font-black">Time saved: {timeSaved(month.minutesSaved)}.</span>{" "}
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
          <ol className="flex flex-col divide-y rounded-xl border bg-card">
            {entries.map((e) => (
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
                  {relativeTime(e.at, now)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
