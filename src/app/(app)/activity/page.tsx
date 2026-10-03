import type { Metadata } from "next";
import { Headline } from "@/components/brand/headline";
import { relativeTime } from "@/lib/relative-time";
import { listActivity, MINUTES_PER_SENT_REPLY, monthSummary } from "@/server/activity";
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
  const [entries, month] = await Promise.all([
    listActivity(workspace.id),
    monthSummary(workspace.id, now),
  ]);
  const monthName = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  return (
    <>
      <Headline serif="what got done," heavy="activity." />

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
                <span className={e.byYou ? "font-semibold" : undefined}>{e.text}</span>
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
