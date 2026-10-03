import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { CATEGORIES } from "@/ai/prompts/classify.v1";
import { categoryLabels, categoryTag, isCategory } from "@/config/categories";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { listInboxThreads, type InboxFilter, type InboxRow } from "@/server/inbox";
import { listMailboxes } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";
import { draftReplyAction } from "../queue/actions";
import { markNeedsOwnerAction } from "./actions";

function parseFilter(v: string | string[] | undefined): InboxFilter {
  if (v === "needs_me") return { kind: "needs_me" };
  if (v === "unsorted") return { kind: "unsorted" };
  if (isCategory(v)) return { kind: "category", category: v };
  return { kind: "all" };
}

function filterKey(f: InboxFilter) {
  return f.kind === "category" ? f.category : f.kind;
}

const chips: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_me", label: "Needs me" },
  ...CATEGORIES.map((c) => ({ key: c, label: categoryLabels[c] })),
];

function Details({ row }: { row: InboxRow }) {
  const x = (row.extracted ?? {}) as {
    service_requested?: string | null;
    address?: string | null;
    dates?: string[];
    dollar_amounts?: number[];
  };
  const facts = [
    x.service_requested ? ["Work", x.service_requested] : null,
    x.address ? ["Address", x.address] : null,
    x.dates?.length ? ["When", x.dates.join(", ")] : null,
    x.dollar_amounts?.length
      ? ["Amounts", x.dollar_amounts.map((a) => `$${a.toLocaleString("en-US")}`).join(", ")]
      : null,
  ].filter((f): f is [string, string] => f !== null);
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

export default async function InboxPage(props: PageProps<"/inbox">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const filter = parseFilter(params.c);
  const [rows, boxes] = await Promise.all([
    listInboxThreads(workspace.id, filter),
    listMailboxes(workspace.id),
  ]);
  const active = filterKey(filter);

  return (
    <>
      <Headline serif="everything that came in," heavy="sorted." />

      <nav aria-label="Filter" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {chips.map((c) => (
          <Link
            key={c.key}
            href={c.key === "all" ? "/inbox" : `/inbox?c=${c.key}`}
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

      {boxes.length === 0 ? (
        <p className="text-lg">
          Connect Gmail in{" "}
          <Link href="/settings" className="font-semibold underline underline-offset-4">
            Settings
          </Link>{" "}
          and your email will show up here.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-lg text-muted-foreground">
          {filter.kind === "all"
            ? "Nothing here yet. New email shows up within a few minutes."
            : "Nothing in this group."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id}>
              <details
                className={cn(
                  "group rounded-xl border",
                  row.needsOwner ? "sa-inverted" : "bg-card",
                )}
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
                    {isCategory(row.category) ? categoryTag[row.category] : "Not sorted yet"}
                    {row.needsOwner ? " · Needs you" : ""}
                    {row.priority === "high" && !row.needsOwner ? " · Urgent" : ""}
                  </span>
                  <span
                    className={cn("line-clamp-2", row.needsOwner ? "" : "text-muted-foreground")}
                  >
                    {row.summary ?? row.subject ?? "(no subject)"}
                  </span>
                </summary>
                <div className="flex flex-col gap-3 border-t border-border px-4 pt-3 pb-4">
                  {row.subject ? <p className="text-sm">Subject: {row.subject}</p> : null}
                  {row.needsOwner && row.needsOwnerReason ? (
                    <p className="font-semibold">Why: {row.needsOwnerReason}</p>
                  ) : null}
                  <Details row={row} />
                  {row.category !== "noise" ? (
                    <form action={draftReplyAction}>
                      <input type="hidden" name="threadId" value={row.id} />
                      <Button type="submit" className="w-full">
                        Draft a reply
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
          ))}
        </ul>
      )}
    </>
  );
}
