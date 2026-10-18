import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { OfferButtons } from "@/components/app/offer-buttons";
import { PermitCard } from "@/components/app/permit-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { CATEGORIES } from "@/ai/prompts/classify.v4";
import { categoryLabels, categoryTag, isCategory } from "@/config/categories";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { z } from "zod";
import { inboxPage, type InboxCursor, type InboxFilter, type InboxRow } from "@/server/inbox";
import { listMailboxes } from "@/server/mailboxes";
import { isReadOnly } from "@/server/lifecycle";
import { threadOffers, type ThreadOffers } from "@/server/offers";
import { priceMemoryFor, type PriceMemoryItem } from "@/server/price-memory";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { kindWord, searchText, urgencyWord } from "@/server/inbox-rules";
import { draftReplyAction } from "../queue/actions";
import { channelKind, channelName, openSiteUrl } from "@/server/channel-rules";
import { InboxSearch } from "./inbox-search";
import { markNeedsOwnerAction, takeOffListAction } from "./actions";
import { CalledThem } from "../queue/called-them";
import { Notice } from "@/components/app/notice";
import { NoteLine } from "@/components/app/note-line";
import { ResortSheet, SenderRuleSheet } from "@/components/app/sender-sheets";
import { CONTROL_DONE, CONTROL_ERRORS } from "@/config/control-messages";
import { notesForThreads } from "@/server/customer-notes";
import { companyChoice } from "@/server/owner-sender-rule-rules";

const INBOX_ERRORS: Record<string, string> = {
  ...CONTROL_ERRORS,
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

const INBOX_DONE: Record<string, string> = {
  ...CONTROL_DONE,
  called:
    "Marked as answered by phone. No draft and no nudge for that one unless they write again.",
  off_list: "Taken off your list. It comes back if they write again and it needs you.",
};

/** Inbox rows keep "Ask for a review" (a finished job); "Say thanks" is Money's (2026-10-16). */
const inboxOffers = (o: ThreadOffers | undefined): ThreadOffers | undefined =>
  o ? { ...o, thankYou: false } : undefined;

function parseFilter(v: string | string[] | undefined): InboxFilter {
  if (v === "needs_me") return { kind: "needs_me" };
  if (v === "unsorted") return { kind: "unsorted" };
  if (isCategory(v)) return { kind: "category", category: v };
  return { kind: "all" };
}

/** Check 10 P2: ?before=<ISO time>&after_id=<thread uuid>; bad values are ignored. */
function parseCursor(params: Record<string, string | string[] | undefined>): InboxCursor | null {
  const id = z.string().uuid().safeParse(params.after_id);
  if (!id.success) return null;
  const before = z.string().datetime({ offset: true }).safeParse(params.before);
  return { afterId: id.data, before: before.success ? new Date(before.data) : null };
}

/** The Inbox URL for a chip, optionally at an older page. Ids and times only. */
function inboxHref(key: string, cursor?: InboxCursor | null) {
  const q = new URLSearchParams();
  if (key !== "all") q.set("c", key);
  if (cursor) {
    if (cursor.before) q.set("before", cursor.before.toISOString());
    q.set("after_id", cursor.afterId);
  }
  const s = q.toString();
  return s ? `/inbox?${s}` : "/inbox";
}

function filterKey(f: InboxFilter) {
  return f.kind === "category" ? f.category : f.kind;
}

const chips: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_me", label: "Needs me" },
  ...CATEGORIES.map((c) => ({ key: c, label: categoryLabels[c] })),
  // Check 10 P7: only shown when there's unsorted mail (or it's the open filter).
  { key: "unsorted", label: "Not sorted" },
];

function Details({ row }: { row: InboxRow }) {
  const x = (row.extracted ?? {}) as {
    service_requested?: string | null;
    address?: string | null;
    dates?: string[];
    dollar_amounts?: number[];
    invoice?: {
      invoice_number: string | null;
      amount: number | null;
      due_date: string | null;
      status: "unpaid" | "paid" | "partly_paid" | "unknown";
    } | null;
  };
  const inv = x.invoice;
  const invoiceWords = {
    unpaid: "Unpaid",
    paid: "Paid",
    partly_paid: "Partly paid",
    unknown: null,
  };
  const facts = [
    x.service_requested ? ["Work", x.service_requested] : null,
    x.address ? ["Address", x.address] : null,
    x.dates?.length ? ["When", x.dates.join(", ")] : null,
    x.dollar_amounts?.length
      ? ["Amounts", x.dollar_amounts.map((a) => `$${a.toLocaleString("en-US")}`).join(", ")]
      : null,
    inv
      ? [
          "Invoice",
          [
            inv.invoice_number ? `#${inv.invoice_number}` : null,
            inv.amount !== null ? `$${inv.amount.toLocaleString("en-US")}` : null,
            inv.due_date ? `due ${inv.due_date}` : null,
            invoiceWords[inv.status],
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : null,
  ].filter((f): f is [string, string] => f !== null && f[1] !== "");
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-semibold">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Plan #15: the owner's past prices for similar jobs, as text. Only they see it. */
function PastPricesLine({ prices }: { prices: PriceMemoryItem[] | undefined }) {
  if (!prices?.length) return null;
  return (
    <p className="text-sm">
      <span className="font-semibold">
        {prices.length === 1 ? "Your last similar quote:" : `Last ${prices.length} similar quotes:`}
      </span>{" "}
      {prices.map((p) => `${p.value} (${p.month})`).join(", ")}
    </p>
  );
}

export default async function InboxPage(props: PageProps<"/inbox">) {
  const { workspace } = await requireOwner();
  const readOnly = isReadOnly(workspace);
  const params = await props.searchParams;
  const filter = parseFilter(params.c);
  const cursor = parseCursor(params);
  const [page, boxes] = await Promise.all([
    inboxPage(workspace.id, filter, { cursor }),
    listMailboxes(workspace.id),
  ]);
  // Check 10 P2 / P7: the page's real rows, then the newest folded junk and older unsorted
  // mail (All, first page only).
  const junkIds = new Set(page.junk.rows.map((r) => r.id));
  const olderIds = new Set(page.older.rows.map((r) => r.id));
  const rows = [...page.rows, ...page.junk.rows, ...page.older.rows];
  const active = filterKey(filter);
  const olderHref = page.next ? inboxHref(active, page.next) : null;
  // "Ask for a review" / the closing question, only where the server's rules allow (#29 #26).
  // Read-only accounts get none.
  const offers = await threadOffers(
    workspace.id,
    rows.map((r) => r.id),
  );
  const timeZone = (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York";
  const pastPrices = await priceMemoryFor(
    workspace.id,
    rows.filter((r) => r.category === "quote_request").map((r) => r.id),
    { timeZone },
  );

  // Ideas G7 / H3: the customer of each row (their newest email that isn't a side
  // conversation), its private note, and the email id the sheets post.
  const customerOf = await notesForThreads(
    workspace.id,
    rows.map((r) => r.id),
  );
  const own = boxes.map((b) => b.email);
  const doneMsg = typeof params.done === "string" ? INBOX_DONE[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? INBOX_ERRORS[params.error] : undefined;

  function renderRow(row: InboxRow) {
    return (
      <li key={row.id}>
        <details
          className={cn("group rounded-xl border", row.needsOwner ? "sa-inverted" : "bg-card")}
        >
          <summary className="flex min-h-tap cursor-pointer list-none flex-col gap-1 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-base font-black">
                {row.senderName || row.senderAddress || "Unknown sender"}
              </span>
              <span
                className={cn(
                  "shrink-0 text-sm",
                  row.needsOwner ? "text-ash" : "text-muted-foreground",
                )}
              >
                {row.lastMessageAt ? relativeTime(row.lastMessageAt) : ""}
              </span>
            </div>
            <span className="text-sm font-semibold">
              {/* Check 10 P3: by weight only, first, on every card. */}
              {urgencyWord(row) ? <span className="font-black">{urgencyWord(row)} · </span> : null}
              {kindWord(row, categoryTag, row.olderUnsorted)}
              {row.needsOwner ? " · Needs you" : ""}
              {row.replyState ? ` · ${row.replyState}` : ""}
              {row.pendingDraftId ? " · Draft ready" : ""}
            </span>
            {row.needsOwner && row.needsOwnerReason ? (
              // Check 10 P5: the reason on the face of the card, without opening it.
              <span className="line-clamp-1 font-semibold">{row.needsOwnerReason}</span>
            ) : null}
            <span className={cn("line-clamp-2", row.needsOwner ? "" : "text-muted-foreground")}>
              {row.summary ?? row.subject ?? "(no subject)"}
            </span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-border px-4 pt-3 pb-4">
            {row.category === null ? (
              // Check 10 P7: never promise a sort that won't come.
              <p className="text-sm font-semibold">
                {row.olderUnsorted
                  ? "This came in before Squared Away started sorting your email. It's safe in Gmail."
                  : "We'll sort this within a few minutes. It's safe in Gmail."}
              </p>
            ) : null}
            {/* Check 10 P6: the customer's page, by the opaque key of their newest email (never
                an address in a URL). Lead websites and phone services aren't customers. */}
            {customerOf.get(row.id)?.address && !row.leadChannel ? (
              <p className="text-sm">
                From{" "}
                <Link
                  href={`/customers/${customerOf.get(row.id)!.key}`}
                  className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
                >
                  {row.senderName || row.senderAddress || "this customer"}
                </Link>
              </p>
            ) : null}
            <NoteLine note={customerOf.get(row.id)?.note} editKey={customerOf.get(row.id)?.key} />
            {row.subject ? <p className="text-sm">Subject: {row.subject}</p> : null}
            {row.needsOwner && row.needsOwnerReason ? (
              <p className="font-semibold">Why: {row.needsOwnerReason}</p>
            ) : null}
            <PermitCard
              permit={
                (row.extracted as { permit?: Parameters<typeof PermitCard>[0]["permit"] })?.permit
              }
            />
            <Details row={row} />
            <PastPricesLine prices={pastPrices.get(row.id)} />
            {row.leadChannel ? (
              // Leads package: nobody reads an email reply to a lead website or a phone message.
              openSiteUrl(row.leadChannel) ? (
                <a
                  href={openSiteUrl(row.leadChannel)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-tap items-center justify-center rounded-lg border-2 border-current px-4 font-black"
                >
                  Open {channelName(row.leadChannel)}
                </a>
              ) : (
                <p className="text-sm font-semibold">
                  {channelKind(row.leadChannel) === "site"
                    ? "Answer them on the website."
                    : "Call or text them back from your own phone."}
                </p>
              )
            ) : row.pendingDraftId ? (
              // Check 10 P4: the draft already exists; go to it instead of writing another.
              <Link
                href={`/queue?t=${row.id}#t-${row.id}`}
                className={cn(buttonVariants(), "w-full")}
              >
                See the draft
              </Link>
            ) : row.category !== "noise" && !readOnly ? (
              <form action={draftReplyAction}>
                <input type="hidden" name="threadId" value={row.id} />
                <Button type="submit" className="w-full">
                  Draft a reply
                </Button>
              </form>
            ) : null}
            {!readOnly ? (
              // "Say thanks" lives on Money's paid rows only (2026-10-16).
              <OfferButtons threadId={row.id} offers={inboxOffers(offers.get(row.id))} />
            ) : null}
            <a
              href={gmailThreadLink(row)}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "outline" }), "w-full")}
            >
              Open in Gmail
            </a>
            {!readOnly ? (
              <ResortSheet threadId={row.id} current={row.category} back="inbox" />
            ) : null}
            {/* The sheet names the same email the server keys the rule on (the customer's
                newest email that isn't a side conversation). */}
            {!readOnly && customerOf.get(row.id)?.address ? (
              <SenderRuleSheet
                messageId={customerOf.get(row.id)!.key}
                who={
                  customerOf.get(row.id)!.address === row.senderAddress && row.senderName
                    ? row.senderName
                    : customerOf.get(row.id)!.address!
                }
                address={customerOf.get(row.id)!.address!}
                company={companyChoice(customerOf.get(row.id)!.address!, own)}
                back="inbox"
              />
            ) : null}
            {!readOnly && row.replyState === "Waiting on you" ? (
              // Check 10 P1: answered by phone, from the Inbox too.
              <CalledThem
                threadId={row.id}
                hasDraft={row.pendingDraftId != null}
                inverted={row.needsOwner}
                back="inbox"
              />
            ) : null}
            {!readOnly && row.needsOwner && row.replyState !== "Waiting on you" ? (
              // Check 10 P1: the customer isn't waiting, so any flag can come off by hand.
              <form action={takeOffListAction}>
                <input type="hidden" name="threadId" value={row.id} />
                <Button type="submit" variant="outline" className="w-full">
                  Take it off my list
                </Button>
              </form>
            ) : null}
            {!row.needsOwner ? (
              <form action={markNeedsOwnerAction}>
                <input type="hidden" name="threadId" value={row.id} />
                <Button type="submit" variant="outline" className="w-full">
                  This one needs me
                </Button>
              </form>
            ) : null}
          </div>
        </details>
      </li>
    );
  }

  return (
    <>
      <Headline serif="everything that came in," heavy="sorted." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <nav aria-label="Filter" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {chips
          .filter((c) => c.key !== "unsorted" || page.hasUnsorted || active === "unsorted")
          .map((c) => (
            <Link
              key={c.key}
              href={inboxHref(c.key)}
              aria-current={active === c.key ? "page" : undefined}
              className={cn(
                "inline-flex min-h-tap shrink-0 items-center rounded-full border px-4 text-sm font-semibold whitespace-nowrap",
                active === c.key ? "border-charcoal bg-charcoal text-offwhite" : "bg-card",
              )}
            >
              {c.label}
            </Link>
          ))}
      </nav>

      {cursor ? (
        <Link
          href={inboxHref(active)}
          className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
        >
          Back to newest
        </Link>
      ) : null}

      {boxes.length === 0 ? (
        <p className="text-lg">
          Connect Gmail in{" "}
          <Link href="/settings/gmail" className="font-semibold underline underline-offset-4">
            Settings
          </Link>{" "}
          and your email will show up here.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-lg text-muted-foreground">
          {cursor
            ? "No older emails."
            : filter.kind === "all"
              ? "Nothing here yet. New email shows up within a few minutes."
              : "Nothing in this group."}
        </p>
      ) : (
        <InboxSearch
          rows={rows.map((r) => ({
            id: r.id,
            text: searchText({
              senderName: r.senderName,
              senderAddress: r.senderAddress,
              subject: r.subject,
              summary: r.summary,
              categoryLabel: isCategory(r.category) ? categoryLabels[r.category] : null,
            }),
            group: junkIds.has(r.id) ? "junk" : olderIds.has(r.id) ? "older" : "main",
            node: renderRow(r),
          }))}
          junkCount={page.junk.count}
          olderCount={page.older.count}
          olderHref={olderHref}
        />
      )}
    </>
  );
}
