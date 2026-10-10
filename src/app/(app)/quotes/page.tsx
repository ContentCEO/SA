import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { formatCents, stageLabel, type QuoteStage } from "@/server/quote-rules";
import { listQuotes, type QuoteRow } from "@/server/quotes";
import { requireOwner } from "@/server/session";
import { markQuoteAction } from "./actions";

export const metadata: Metadata = { title: "Quotes" };

const FILTERS = [
  ["open", "Open"],
  ["waiting_on_you", "Waiting on you"],
  ["quiet", "Gone quiet"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;
type Filter = (typeof FILTERS)[number][0];
const OPEN: QuoteStage[] = ["waiting_on_you", "talking", "quiet"];

const done: Record<string, string> = {
  won: "Marked won. Nice one.",
  lost: "Marked lost.",
  reopen: "Reopened.",
};
const errors: Record<string, string> = {
  amount: "That amount didn't look right. Type just the number, like 1450.",
  unknown: "That didn't work. Refresh and try again.",
};

function QuoteCard({ q, filter }: { q: QuoteRow; filter: Filter }) {
  const name = q.customerName ?? q.customerAddress ?? "Someone";
  const decided = q.stage === "won" || q.stage === "lost";
  return (
    <article
      aria-label={`Quote for ${name}`}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-4",
        q.stage === "waiting_on_you" ? "sa-inverted" : "border bg-card",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-lg font-black">{name}</span>
        <span className="shrink-0 text-sm opacity-80">
          {q.lastMessageAt ? relativeTime(q.lastMessageAt) : ""}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">{stageLabel[q.stage]}</span>
        {q.amountCents ? (
          <span className="text-lg font-black">{formatCents(q.amountCents)}</span>
        ) : null}
      </div>
      {q.summary ? <p className="opacity-80">{q.summary}</p> : null}

      {decided ? (
        <form action={markQuoteAction}>
          <input type="hidden" name="threadId" value={q.threadId} />
          <input type="hidden" name="outcome" value="reopen" />
          <input type="hidden" name="stage" value={filter} />
          <Button type="submit" variant="ghost" className="w-full">
            Reopen
          </Button>
        </form>
      ) : (
        <details className="group">
          <summary className="inline-flex min-h-tap w-full cursor-pointer list-none items-center justify-center rounded-lg border font-semibold">
            Mark won or lost
          </summary>
          <form action={markQuoteAction} className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="threadId" value={q.threadId} />
            <input type="hidden" name="stage" value={filter} />
            <label className="flex flex-col gap-1 text-sm font-semibold">
              Job amount (optional)
              <input
                name="amount"
                inputMode="decimal"
                placeholder={q.amountCents ? String(q.amountCents / 100) : "e.g. 1450"}
                className="min-h-tap rounded-lg border bg-background px-3 text-base text-foreground"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button type="submit" name="outcome" value="won">
                Mark won
              </Button>
              <Button type="submit" name="outcome" value="lost" variant="outline">
                Mark lost
              </Button>
            </div>
          </form>
        </details>
      )}
      <a
        href={gmailThreadLink(q)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-tap items-center justify-center font-semibold underline underline-offset-4"
      >
        Open in Gmail
      </a>
    </article>
  );
}

export default async function QuotesPage(props: PageProps<"/quotes">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const filter: Filter = FILTERS.some(([k]) => k === params.stage)
    ? (params.stage as Filter)
    : "open";
  const { quotes, totals, quietDays } = await listQuotes(workspace.id);
  const shown = quotes.filter((q) =>
    filter === "open" ? OPEN.includes(q.stage) : q.stage === filter,
  );
  const count = (f: Filter) =>
    quotes.filter((q) => (f === "open" ? OPEN.includes(q.stage) : q.stage === f)).length;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;

  return (
    <>
      <Headline serif="your quotes," heavy="won and waiting." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section
        aria-labelledby="totals"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="totals" className="text-lg font-black">
          Last 30 days
        </h2>
        <dl className="grid grid-cols-3 gap-3">
          {[
            ["Requests", String(totals.requests)],
            ["Quoted", formatCents(totals.quotedCents)],
            ["Won", formatCents(totals.wonCents)],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-black">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">
          {totals.winRatePct !== null
            ? `You won ${totals.winRatePct}% of the quotes you marked. `
            : "Tap Mark won or lost on a quote to track your win rate. "}
          Amounts come from the price in your reply, or what you type.
        </p>
      </section>

      <nav aria-label="Quote filter" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {FILTERS.map(([key, label]) => (
          <Link
            key={key}
            href={key === "open" ? "/quotes" : `/quotes?stage=${key}`}
            aria-current={filter === key ? "page" : undefined}
            className={cn(
              "inline-flex min-h-tap shrink-0 items-center rounded-full px-4 font-semibold",
              filter === key ? "sa-inverted" : "border",
            )}
          >
            {label} ({count(key)})
          </Link>
        ))}
      </nav>

      {shown.length ? (
        <div className="flex flex-col gap-3">
          {shown.map((q) => (
            <QuoteCard key={q.threadId} q={q} filter={filter} />
          ))}
        </div>
      ) : (
        <p className="text-lg">
          {quotes.length
            ? "Nothing here right now."
            : "No quote requests yet. When a customer asks for a price, it shows up here by itself."}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        &ldquo;Gone quiet&rdquo; means you replied {quietDays}+ days ago and haven&apos;t heard
        back.
      </p>
    </>
  );
}
