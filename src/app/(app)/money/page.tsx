import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { OfferButtons } from "@/components/app/offer-buttons";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { MAX_FOLLOWUPS } from "@/server/drafts";
import { isReadOnly } from "@/server/lifecycle";
import { listMoney, type MoneyRow } from "@/server/money";
import { chaseLine } from "@/server/money-rules";
import { threadOffers, type ThreadOffers } from "@/server/offers";
import { formatCents } from "@/server/quote-rules";
import { requireOwner } from "@/server/session";
import {
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
      <div className="flex items-baseline justify-between gap-3">
        <span id={nameId} className="min-w-0 truncate text-lg font-black">
          {nameOf(r)}
        </span>
        {r.amountCents ? (
          <span className="shrink-0 text-2xl font-black">{formatCents(r.amountCents)}</span>
        ) : (
          <span className="shrink-0 font-semibold">Amount not stated</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-semibold">{r.due.text}</span>
        {r.invoiceNumber ? (
          <span className="min-w-0 truncate text-sm opacity-80">Invoice {r.invoiceNumber}</span>
        ) : null}
      </div>
      {r.earlierOpen.map((e, i) => (
        <p key={i} className="text-sm font-semibold">
          {`Earlier invoice${e.invoiceNumber ? ` ${e.invoiceNumber}` : ""} (${formatCents(
            e.amountCents,
          )}) may still be open. It's counted in the total.`}
        </p>
      ))}
      <p className="text-sm opacity-80" data-testid="chase-line">
        {chaseLine(r.chase, MAX_FOLLOWUPS)}
      </p>
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
            <Button type="submit" variant="ghost" className="w-full">
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
      <div className="flex items-baseline justify-between gap-3">
        <span id={nameId} className="min-w-0 truncate font-semibold">
          {nameOf(r)}
        </span>
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
  const { owed, paidRecently, hidden, totalOwedCents } = await listMoney(workspace.id, now);
  const readOnly = isReadOnly(workspace, now);
  const showHidden = params.show === "hidden";
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const offers = await threadOffers(
    workspace.id,
    paidRecently.map((r) => r.threadId),
    now,
  );
  const pastDue = owed.filter((r) => (r.due.daysPastDue ?? 0) > 0).length;

  return (
    <>
      <Headline serif="money owed," heavy="who still owes you." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section
        aria-labelledby="owed-total"
        className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="owed-total" className="text-lg font-black">
          Owed to you
        </h2>
        <p className="text-4xl font-black">{formatCents(totalOwedCents)}</p>
        <p className="text-muted-foreground">
          {owed.length === 0
            ? "Nothing open."
            : `${owed.length} invoice${owed.length === 1 ? "" : "s"}${
                pastDue ? `, ${pastDue} past due` : ""
              }. Oldest due first.`}
        </p>
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
          Nothing owed that we can see. Invoices show up here when a customer email mentions one.
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
