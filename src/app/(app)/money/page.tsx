import type { Metadata } from "next";
import { noticeText } from "@/lib/notice-text";
import Link from "next/link";
import { CustomerName } from "@/components/app/customer-name";
import { Notice } from "@/components/app/notice";
import { OfferButtons } from "@/components/app/offer-buttons";
import { Headline } from "@/components/brand/headline";
import { UpdatedAt } from "@/components/app/updated-at";
import { updatedTime } from "@/lib/refresh-rules";
import { getBusinessProfile } from "@/server/profile";
import { usableTimeZone } from "@/server/snooze-rules";
import { Button } from "@/components/ui/button";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { numberWord } from "@/lib/number-words";
import { CLASSIFY_LOOKBACK_DAYS } from "@/server/classification";
import { MAX_FOLLOWUPS } from "@/server/drafts";
import { isReadOnly } from "@/server/lifecycle";
import { listMoney, type MoneyRow } from "@/server/money";
import { chaseLine } from "@/server/money-rules";
import { threadOffers, type ThreadOffers } from "@/server/offers";
import { formatCents } from "@/server/quote-rules";
import { requireOwner } from "@/server/session";
import {
  draftReminderAction,
  markInvoicePaidAction,
  notOwedAction,
  putBackAction,
  undoInvoicePaidAction,
} from "./actions";

export const metadata: Metadata = { title: "Money owed" };

const done: Record<string, string> = {
  paid: "Marked paid. No more nudges for that one.",
  unpaid: "Back on the list.",
  hidden: "Hidden. It won't count as owed, and we won't chase it.",
  restored: "Put back on the list.",
};
const errors: Record<string, string> = {
  // Check 12 P8: "Draft a reminder" (fixed codes from draftReminderAction).
  reminder_exists: "A reply on that one is already waiting in your Queue.",
  reminder_cap: "That one has had both nudges already, so we won't write another.",
  reminder_away: "Away mode is on, so reminders wait until you're back.",
  reminder_failed: "We couldn't write that reminder. Try again in a minute.",
  ai_busy: "Writing is slow right now. Try again in a minute.",
  busy: "That's a lot of drafts for one hour. Try again a little later.",
  reconnect: "Gmail needs reconnecting before we can write drafts. The note at the top says how.",
  paused: "That Gmail address is paused on your plan, so nothing is drafted from it.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

const nameOf = (r: MoneyRow) => r.customerName ?? r.customerAddress ?? "Someone";

/**
 * One invoice still owed. The card's accessible name is the visible name (aria-labelledby):
 * names and amounts never go in an aria-label, which error reports copy from taps (A9).
 */
function OwedCard({ r, readOnly }: { r: MoneyRow; readOnly: boolean }) {
  const first = nameOf(r).split(/[\s,@]+/)[0] || "them";
  const pastDue = (r.due.daysPastDue ?? 0) > 0;
  const nameId = `owed-${r.threadId}`;
  return (
    <article
      aria-labelledby={nameId}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-4",
        pastDue ? "sa-inverted" : "border bg-card",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <CustomerName
          id={nameId}
          name={nameOf(r)}
          customerKey={r.customerKey}
          className="text-lg font-black"
        />
        {r.amountCents ? (
          <span className="flex shrink-0 flex-col items-end">
            <span className="text-2xl font-black">{formatCents(r.amountCents)}</span>
            {/* Check 12 P5: where the figure came from, when it wasn't the customer's email. */}
            {r.amountFromYourEmail ? (
              <span className="text-sm text-muted-foreground">From your email</span>
            ) : null}
          </span>
        ) : (
          <span className="shrink-0 font-semibold">Amount not stated</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex flex-col">
          <span className="font-semibold">{r.due.text}</span>
          {/* Check 12 P6: the due day itself. */}
          {r.due.day ? <span className="text-sm text-muted-foreground">{r.due.day}</span> : null}
        </span>
        {r.invoiceNumber ? (
          <span className="min-w-0 text-base break-words text-muted-foreground">
            Invoice {r.invoiceNumber}
          </span>
        ) : null}
      </div>
      {r.earlierOpen.map((e, i) => (
        <p key={i} className="text-sm font-semibold">
          {`Earlier invoice${e.invoiceNumber ? ` ${e.invoiceNumber}` : ""} (${formatCents(
            e.amountCents,
          )}) may still be open. It's counted in the total.`}
        </p>
      ))}
      <p className="text-base text-muted-foreground" data-testid="chase-line">
        {chaseLine(r.chase, MAX_FOLLOWUPS)}
      </p>
      {readOnly ? null : r.pendingDraftId ? (
        // Check 12 P8: a reply is already waiting — one tap to it.
        <div className="flex flex-col gap-1">
          <p className="font-semibold">A reply to {first} is waiting in your Queue.</p>
          <Link
            href={`/queue#t-${r.threadId}`}
            className="inline-flex min-h-tap items-center justify-center rounded-lg border font-semibold"
          >
            See it
          </Link>
        </div>
      ) : r.canDraftReminder ? (
        // Check 12 P8: drafts only — it waits in the Queue for Send reply.
        <form action={draftReminderAction}>
          <input type="hidden" name="threadId" value={r.threadId} />
          <Button type="submit" variant="outline" className="w-full">
            Draft a reminder
          </Button>
        </form>
      ) : null}
      {readOnly ? null : (
        <div className="flex flex-col gap-2">
          <form action={markInvoicePaidAction}>
            <input type="hidden" name="threadId" value={r.threadId} />
            <Button type="submit" className="w-full">
              Mark paid
            </Button>
          </form>
          <form action={notOwedAction}>
            <input type="hidden" name="threadId" value={r.threadId} />
            {/* Check 7 P11: a real action gets an edge (light on the charcoal card). */}
            <Button
              type="submit"
              variant="outline"
              className={cn("w-full", pastDue && "border-foreground")}
            >
              Not owed to me
            </Button>
          </form>
        </div>
      )}
      <a
        href={gmailThreadLink(r)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-tap items-center justify-center font-semibold underline underline-offset-4"
      >
        Open in Gmail
      </a>
    </article>
  );
}

/** A paid (or hidden) row, with its one-tap way back. */
function SettledRow({
  r,
  readOnly,
  now,
  kind,
  offers,
}: {
  r: MoneyRow;
  readOnly: boolean;
  now: Date;
  kind: "paid" | "hidden";
  offers?: ThreadOffers;
}) {
  const nameId = `${kind}-${r.threadId}`;
  return (
    <li aria-labelledby={nameId} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <CustomerName
          id={nameId}
          name={nameOf(r)}
          customerKey={r.customerKey}
          className="font-semibold"
        />
        <span className="shrink-0 font-black">
          {r.amountCents ? formatCents(r.amountCents) : "Amount not stated"}
        </span>
      </div>
      {kind === "paid" ? (
        <p className="text-sm text-muted-foreground">
          Paid {r.paidAt ? relativeTime(r.paidAt, now) : ""}
          {r.paidSource === "auto" ? " (we spotted the payment)" : ""}
        </p>
      ) : null}
      {readOnly || kind !== "paid" ? null : (
        // Paid: "Say thanks" (2026-10-16) — it carries the review ask when the review rules allow
        // one, so the separate "Ask for a review" button isn't shown here any more.
        <OfferButtons
          threadId={r.threadId}
          offers={
            offers
              ? { review: false, closingQuestion: false, thankYou: offers.thankYou }
              : undefined
          }
        />
      )}
      {readOnly ? null : (
        <form action={kind === "paid" ? undoInvoicePaidAction : putBackAction}>
          <input type="hidden" name="threadId" value={r.threadId} />
          <Button type="submit" variant="outline" className="w-full">
            {kind === "paid" ? "Undo" : "Put back"}
          </Button>
        </form>
      )}
    </li>
  );
}

export default async function MoneyPage(props: PageProps<"/money">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const now = new Date();
  const [{ owed, paidRecently, hidden, totalOwedCents }, profile] = await Promise.all([
    listMoney(workspace.id, now),
    getBusinessProfile(workspace.id),
  ]);
  const readOnly = isReadOnly(workspace, now);
  const showHidden = params.show === "hidden";
  const doneMsg = noticeText(done, params.done);
  const errorMsg = noticeText(errors, params.error);
  const offers = await threadOffers(
    workspace.id,
    paidRecently.map((r) => r.threadId),
    now,
  );
  const pastDue = owed.filter((r) => (r.due.daysPastDue ?? 0) > 0).length;
  const noAmount = owed.filter((r) => !r.amountCents).length;
  const lookbackDays: number = CLASSIFY_LOOKBACK_DAYS;
  const weeks = lookbackDays / 7;
  const lookback = Number.isInteger(weeks)
    ? `${numberWord(weeks)} week${weeks === 1 ? "" : "s"}`
    : `${lookbackDays} days`;

  return (
    <>
      <Headline serif="money owed," heavy="who still owes you." />
      <UpdatedAt time={updatedTime(now, usableTimeZone(profile?.timeZone))} what="money list" />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section
        aria-labelledby="owed-total"
        className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="owed-total" className="text-lg font-black">
          Owed to you
        </h2>
        {owed.length === 0 ? (
          // Check 12 P9: never a big "$0" — it only means we haven't found any yet.
          <>
            <p className="text-2xl font-black">No open invoices found</p>
            <p className="text-muted-foreground">
              We look at invoice emails from the last {lookback} of sorting and everything new.
            </p>
          </>
        ) : (
          <>
            <p className="text-4xl font-black">{formatCents(totalOwedCents)}</p>
            <p className="text-sm font-semibold">Counted from your email, not your books.</p>
            <p className="text-muted-foreground">
              {`${owed.length} invoice${owed.length === 1 ? "" : "s"}${
                noAmount ? `, ${noAmount} with no amount yet` : ""
              }${pastDue ? `, ${pastDue} past due` : ""}. Oldest due first.`}
            </p>
          </>
        )}
      </section>

      {owed.length ? (
        <ol className="flex flex-col gap-3" aria-label="Invoices still owed">
          {owed.map((r) => (
            <li key={r.threadId}>
              <OwedCard r={r} readOnly={readOnly} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-lg">
          No invoices found in your email yet. When you send one or a customer writes about one, it
          shows up here.
        </p>
      )}

      {paidRecently.length ? (
        <section aria-labelledby="paid" className="flex flex-col gap-3">
          <h2 id="paid" className="text-xl font-black">
            Paid in the last 30 days
          </h2>
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {paidRecently.map((r) => (
              <SettledRow
                key={r.threadId}
                r={r}
                readOnly={readOnly}
                now={now}
                kind="paid"
                offers={offers.get(r.threadId)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {hidden.length ? (
        showHidden ? (
          <section aria-labelledby="hidden" className="flex flex-col gap-3">
            <h2 id="hidden" className="text-xl font-black">
              Not owed to you
            </h2>
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {hidden.map((r) => (
                <SettledRow key={r.threadId} r={r} readOnly={readOnly} now={now} kind="hidden" />
              ))}
            </ul>
            <Link
              href="/money"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Hide this list
            </Link>
          </section>
        ) : (
          <Link
            href="/money?show=hidden"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            Hidden ({hidden.length})
          </Link>
        )
      ) : null}

      <p className="text-sm text-muted-foreground">
        From invoice details in your email. No accounting connection. Paid invoices are never
        chased. When a customer says they paid, or a Stripe or QuickBooks receipt names the invoice
        number, we mark it paid for you — tap Undo if we got it wrong.
      </p>
    </>
  );
}
