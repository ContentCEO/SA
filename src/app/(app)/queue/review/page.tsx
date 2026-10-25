import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { categoryLabels } from "@/config/categories";
import {
  BATCH_CATEGORIES,
  isBatchCategory,
  VISIT_TIME_HELD_LINE,
  type BatchCategory,
} from "@/server/batch-rules";
import { batchReview } from "@/server/drafts";
import { canSend, isReadOnly, sendingBlockedReason } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";
import { cn } from "@/lib/utils";
import { BatchForm } from "./batch-form";

// Check 32 P6: every screen has its own title ("… · Squared Away" from the root template).
export const metadata: Metadata = { title: "Send together" };

/**
 * Plan #5 "Review all ready": every draft labelled Ready in the categories the
 * owner picks — never complaints, invoices with amounts, needs-you or flagged
 * ones. Each shows who it goes to and how it starts.
 */
export default async function ReviewReadyPage(props: PageProps<"/queue/review">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const raw = params.cat === undefined ? [...BATCH_CATEGORIES] : [params.cat].flat();
  const picked = raw.filter(isBatchCategory);
  const { rows, heldForVisitTime } = await batchReview(workspace.id, picked);
  const sending = canSend(workspace) && !isReadOnly(workspace);

  const toggle = (c: BatchCategory) => {
    const next = picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c];
    const qs = new URLSearchParams(next.map((x) => ["cat", x]));
    return next.length ? `/queue/review?${qs}` : "/queue/review?cat=";
  };

  return (
    <>
      <Headline serif="all ready," heavy="send together." />
      {params.error === "none" ? (
        <Notice strong>Nothing was sent — none of those could go together any more.</Notice>
      ) : null}
      <p>
        Only replies marked Ready, with nothing to check and no gaps. Complaints, bills with amounts
        and anything that needs you always go one at a time.
      </p>

      <nav aria-label="Which kinds" className="flex flex-wrap gap-2">
        {BATCH_CATEGORIES.map((c) => (
          <Link
            key={c}
            href={toggle(c)}
            // Check 32 P8: links can't be pressed toggles (aria-pressed); the chosen ones are
            // marked current, and say so in words for every screen reader.
            aria-current={picked.includes(c) ? "true" : undefined}
            className={cn(
              "inline-flex min-h-tap items-center rounded-lg border-2 border-charcoal px-3",
              picked.includes(c) ? "sa-inverted font-black" : "font-semibold",
            )}
          >
            {categoryLabels[c]}
            {picked.includes(c) ? <span className="sr-only"> (chosen)</span> : null}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-xl font-black">Nothing ready to send together right now.</p>
      ) : (
        <ul aria-label="Replies to send" className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.draftId} className="rounded-xl border bg-card p-3">
              <p className="font-black">To {r.to}</p>
              {r.to !== r.toAddress ? <p className="text-sm break-all">To: {r.toAddress}</p> : null}
              <p className="text-muted-foreground">{r.firstLine}</p>
            </li>
          ))}
        </ul>
      )}
      {/* Check 41 P2: why some scheduling replies aren't here (a count reason, no names). */}
      {heldForVisitTime ? <p className="font-semibold">{VISIT_TIME_HELD_LINE}</p> : null}

      {rows.length ? (
        sending ? (
          <BatchForm
            rows={rows.map((r) => ({
              draftId: r.draftId,
              seenHash: r.seenHash,
              toAddress: r.toAddress,
            }))}
            categories={picked}
          />
        ) : (
          <p role="note" className="sa-inverted rounded-lg p-3 font-semibold">
            {sendingBlockedReason(workspace)}
          </p>
        )
      ) : null}
      <Link href="/queue" className="inline-flex min-h-tap items-center font-semibold underline">
        Back to the queue
      </Link>
    </>
  );
}
