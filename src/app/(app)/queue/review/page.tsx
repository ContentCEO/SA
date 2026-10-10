import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { categoryLabels } from "@/config/categories";
import { BATCH_CATEGORIES, isBatchCategory, type BatchCategory } from "@/server/batch-rules";
import { batchCandidates } from "@/server/drafts";
import { canSend, isReadOnly, sendingBlockedReason } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";
import { cn } from "@/lib/utils";
import { BatchForm } from "./batch-form";

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
  const rows = await batchCandidates(workspace.id, picked);
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
            aria-pressed={picked.includes(c)}
            className={cn(
              "inline-flex min-h-tap items-center rounded-lg border-2 border-charcoal px-3",
              picked.includes(c) ? "sa-inverted font-black" : "font-semibold",
            )}
          >
            {categoryLabels[c]}
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
              <p className="text-muted-foreground">{r.firstLine}</p>
            </li>
          ))}
        </ul>
      )}

      {rows.length ? (
        sending ? (
          <BatchForm draftIds={rows.map((r) => r.draftId)} categories={picked} />
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
