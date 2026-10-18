import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { OfferButtons } from "@/components/app/offer-buttons";
import { Headline } from "@/components/brand/headline";
import { Button, buttonVariants } from "@/components/ui/button";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { isReadOnly } from "@/server/lifecycle";
import { threadOffers, type ThreadOffers } from "@/server/offers";
import {
  decidedLabel,
  formatCents,
  isDecidedStage,
  QUOTE_OUTCOMES,
  stageLabel,
  type QuoteOutcome,
  type QuoteStage,
} from "@/server/quote-rules";
import { listQuotes, type QuoteRow } from "@/server/quotes";
import { requireOwner } from "@/server/session";
import { changeAmountAction, lostReasonAction, markQuoteAction } from "./actions";
import { leadSourcePay } from "@/server/lead-pay";
import { leadPaySentence } from "@/server/quote-rules";
import { LOST_REASON_BUTTONS, LOST_REASON_WORDS, LOST_REASONS } from "@/server/quote-rules";

export const metadata: Metadata = { title: "Quotes" };

const FILTERS = [
  ["open", "Open"],
  ["waiting_on_you", "Waiting on you"],
  ["quiet", "Gone quiet"],
  ["won", "Won"],
  ["lost", "Lost"],
  ["no_answer", "No answer"],
] as const;
type Filter = (typeof FILTERS)[number][0];
const OPEN: QuoteStage[] = ["waiting_on_you", "replied", "talking", "quiet"];

const done: Record<string, string> = {
  won: "Marked won. Nice one.",
  lost: "Marked lost. Why? One tap on the card, optional.",
  lost_reason: "Got it.",
  amount: "Amount saved.",
  no_answer: "Marked no answer.",
  reopen: "Reopened.",
};
const errors: Record<string, string> = {
  amount: "That amount didn't look right. Type just the number, like 1450.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

const markLabel: Record<QuoteOutcome, string> = {
  won: "Mark won",
  lost: "Mark lost",
  no_answer: "Mark no answer",
};

/** "What you'll charge (optional)", prefilled with the amount we found (or the one saved). */
function AmountField({ id, cents }: { id: string; cents: number | null }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm font-semibold">
      What you&apos;ll charge (optional)
      <input
        id={id}
        name="amount"
        inputMode="decimal"
        defaultValue={cents ? String(cents / 100) : ""}
        placeholder="e.g. 1450"
        className="min-h-tap rounded-lg border bg-background px-3 text-base text-foreground"
      />
    </label>
  );
}

function QuoteCard({
  q,
  filter,
  readOnly,
  offers,
  timeZone,
}: {
  q: QuoteRow;
  filter: Filter;
  readOnly: boolean;
  offers: ThreadOffers | undefined;
  timeZone: string;
}) {
  const name = q.customerName ?? q.customerAddress ?? "Someone";
  const decided = isDecidedStage(q.stage);
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
        <span className="text-sm font-semibold">
          {/* Check 11 P7: a decided card says when — "Won Oct 14". */}
          {isDecidedStage(q.stage)
            ? decidedLabel(q.stage, q.outcomeAt, timeZone)
            : stageLabel[q.stage]}
          {q.outcomeGuessed ? <span className="font-normal"> (our guess)</span> : null}
        </span>
        {q.amountCents ? (
          <span className="flex items-baseline gap-2">
            {/* Check 11 P2: our pick among several figures in the reply. */}
            {q.amountUnsure ? <span className="text-sm font-semibold">Check amount</span> : null}
            <span className="text-lg font-black">{formatCents(q.amountCents)}</span>
          </span>
        ) : null}
      </div>
      {q.summary ? <p className="opacity-80">{q.summary}</p> : null}
      {readOnly ? null : (
        // Plan #26: only on a quote that went quiet after both nudges (the server decides).
        <OfferButtons
          threadId={q.threadId}
          offers={
            offers
              ? { review: false, closingQuestion: offers.closingQuestion, thankYou: false }
              : undefined
          }
        />
      )}

      {q.stage === "lost" && q.lostReason ? (
        <p className="font-semibold">Lost: {LOST_REASON_WORDS[q.lostReason]}</p>
      ) : null}
      {q.stage === "lost" && !readOnly ? (
        <details className="rounded-lg border" open={!q.lostReason}>
          <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
            {q.lostReason ? "Change why" : "Why did you lose it?"}
          </summary>
          <form action={lostReasonAction} className="flex flex-wrap gap-2 px-3 pb-3">
            <input type="hidden" name="threadId" value={q.threadId} />
            <input type="hidden" name="stage" value={filter} />
            {LOST_REASONS.map((r) => (
              <Button key={r} type="submit" name="reason" value={r} variant="outline">
                {LOST_REASON_BUTTONS[r]}
              </Button>
            ))}
          </form>
        </details>
      ) : null}
      {readOnly ? null : decided ? (
        // One tap to change it — our guess or the owner's own mark.
        <>
          {q.stage === "won" ? (
            // Check 11 P7: fix a won amount without reopening the quote.
            <details className="rounded-lg border">
              <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
                Change amount
              </summary>
              <form action={changeAmountAction} className="flex flex-col gap-2 px-3 pb-3">
                <input type="hidden" name="threadId" value={q.threadId} />
                <input type="hidden" name="stage" value={filter} />
                <AmountField id={`amount-${q.threadId}`} cents={q.amountCents} />
                <Button type="submit">Save amount</Button>
              </form>
            </details>
          ) : null}
          <form action={markQuoteAction} className="flex flex-col gap-2">
            <input type="hidden" name="threadId" value={q.threadId} />
            <input type="hidden" name="stage" value={filter} />
            <div className="grid grid-cols-2 gap-2">
              {QUOTE_OUTCOMES.filter((o) => o !== q.stage).map((o) => (
                <Button key={o} type="submit" name="outcome" value={o} variant="outline">
                  {markLabel[o]}
                </Button>
              ))}
            </div>
            <Button type="submit" name="outcome" value="reopen" variant="ghost" className="w-full">
              Reopen
            </Button>
          </form>
        </>
      ) : (
        <details className="group">
          <summary className="inline-flex min-h-tap w-full cursor-pointer list-none items-center justify-center rounded-lg border font-semibold">
            Mark how it ended
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            {/* Check 11 P7: only Won asks for a dollar figure. */}
            <details className="rounded-lg border">
              <summary className="inline-flex min-h-tap w-full cursor-pointer list-none items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
                Mark won
              </summary>
              <form action={markQuoteAction} className="flex flex-col gap-2 p-3">
                <input type="hidden" name="threadId" value={q.threadId} />
                <input type="hidden" name="stage" value={filter} />
                <input type="hidden" name="outcome" value="won" />
                <AmountField id={`won-${q.threadId}`} cents={q.amountCents} />
                <Button type="submit">Save as won</Button>
              </form>
            </details>
            <form action={markQuoteAction} className="grid grid-cols-2 gap-2">
              <input type="hidden" name="threadId" value={q.threadId} />
              <input type="hidden" name="stage" value={filter} />
              <Button type="submit" name="outcome" value="lost" variant="outline">
                Mark lost
              </Button>
              <Button type="submit" name="outcome" value="no_answer" variant="outline">
                Mark no answer
              </Button>
            </form>
          </div>
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
  const [{ quotes, totals, quietDays, timeZone }, leadPay] = await Promise.all([
    listQuotes(workspace.id),
    leadSourcePay(workspace.id),
  ]);
  const readOnly = isReadOnly(workspace);
  const shown = quotes.filter((q) =>
    filter === "open" ? OPEN.includes(q.stage) : q.stage === filter,
  );
  const offers = await threadOffers(
    workspace.id,
    shown.map((q) => q.threadId),
  );
  const count = (f: Filter) =>
    quotes.filter((q) => (f === "open" ? OPEN.includes(q.stage) : q.stage === f)).length;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;

  return (
    <>
      <Headline serif="your quotes," heavy="won and waiting." />
      <Link
        href="/money"
        className={cn(buttonVariants({ variant: "outline" }), "min-h-tap self-start")}
      >
        Money owed →
      </Link>
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
            ["Asked for", String(totals.requests)],
            ["Priced", formatCents(totals.quotedCents)],
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
            ? `You won ${totals.winRatePct}% of the quotes that ended in the last 30 days (won, lost or no answer). `
            : "Tap Mark how it ended on a quote to track your win rate. "}
          Last 30 days. Won counts the day you marked it (or we guessed it). Amounts come from the
          price in your reply, or what you type.
        </p>
      </section>

      {leadPay ? (
        <section
          aria-labelledby="sources"
          className="flex flex-col gap-2 rounded-xl border bg-card p-4"
        >
          <h2 id="sources" className="text-lg font-black">
            Where your work comes from
          </h2>
          <p className="text-sm text-muted-foreground">Quote requests from the last 90 days.</p>
          <ul className="flex flex-col gap-1">
            {leadPay.map((r) => (
              <li key={r.label}>{leadPaySentence(r)}</li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Won amounts are the price in your own reply, or the amount you typed when you marked it
            won. Quotes you sent only as a PDF count once you type the amount on Won. Won can be our
            guess for email leads — check Quotes.
          </p>
        </section>
      ) : null}

      {/* Check 11 P5: the chips count every quote, not just the last 30 days. */}
      <p className="text-sm font-semibold text-muted-foreground">All time</p>
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
            <QuoteCard
              key={q.threadId}
              q={q}
              filter={filter}
              readOnly={readOnly}
              offers={offers.get(q.threadId)}
              timeZone={timeZone}
            />
          ))}
        </div>
      ) : (
        <p className="text-lg">
          {quotes.length
            ? "Nothing here right now."
            : "No quote requests yet. When a customer asks for a price, it shows up here by itself."}
        </p>
      )}
      {/* Check 11 P6 / P9: every stage on the screen, one short line each. */}
      <ul
        aria-label="What the stages mean"
        className="flex flex-col gap-1 text-sm text-muted-foreground"
      >
        <li>Waiting on you: the customer wrote last.</li>
        <li>Replied, no price yet: you answered but didn&apos;t give a price (a visit, a call).</li>
        <li>Quoted: you sent a price.</li>
        <li>Gone quiet: you sent a price {quietDays}+ days ago and haven&apos;t heard back.</li>
        <li>
          No answer: can be our guess, a week after two follow-ups or three quiet weeks after your
          price.
        </li>
        <li>Won: can be our guess too, when the customer says go ahead.</li>
        <li>Lost: you marked it lost. Change any of these with one tap.</li>
      </ul>
    </>
  );
}
