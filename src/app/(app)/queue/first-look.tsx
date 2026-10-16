import { PendingButton } from "@/components/app/pending-button";
import { Button } from "@/components/ui/button";
import { CLASSIFY_LOOKBACK_DAYS } from "@/server/classification";
import type { FirstLook } from "@/server/first-week";
import { firstLookLines, foundMoneyLine } from "@/server/first-week-rules";
import { foundMoneyDraftsAction, hideFirstLookAction } from "./first-week-actions";

/**
 * Round 2 (FW D1/D2): the first week's "your last 30 days" card. Counts only, then found money:
 * quotes that slipped, with one tap to have drafts written. Every one is a draft to check.
 */
export function FirstLookCard({ look, readOnly }: { look: FirstLook; readOnly: boolean }) {
  if (!look.show) return null;
  const found = look.offerDrafts && !readOnly ? foundMoneyLine(look.counts) : null;
  return (
    <section
      aria-labelledby="first-look"
      className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
    >
      <h2 id="first-look" className="text-lg font-black">
        Your last 30 days
      </h2>
      {firstLookLines(look.counts, CLASSIFY_LOOKBACK_DAYS).map((l) => (
        <p key={l}>{l}</p>
      ))}
      {found ? (
        <form action={foundMoneyDraftsAction} className="flex flex-col gap-2">
          <p className="font-semibold">{found}</p>
          <PendingButton pending="Starting…" className="w-full">
            Draft them
          </PendingButton>
        </form>
      ) : null}
      <form action={hideFirstLookAction}>
        <Button type="submit" variant="ghost" className="w-full">
          Hide this
        </Button>
      </form>
    </section>
  );
}
