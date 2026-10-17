import {
  askClosingQuestionAction,
  askForReviewAction,
  sayThanksAction,
} from "@/app/(app)/inbox/actions";
import { PendingButton } from "@/components/app/pending-button";
import type { ThreadOffers } from "@/server/offers";

/**
 * The owner-tap offers on a thread (plan #29 review request, #26 closing question). Shown
 * only when the server's rules allow them (threadOffers); a tap drafts the note into the
 * Queue — nothing is sent. Labels are generic: no names or amounts (A9).
 */
// Long labels wrap at 375px instead of running off the card; still at least 44px tall.
const wrap = "h-auto min-h-tap w-full py-2 whitespace-normal";

export function OfferButtons({
  threadId,
  offers,
}: {
  threadId: string;
  offers: ThreadOffers | undefined;
}) {
  if (!offers || (!offers.review && !offers.closingQuestion && !offers.thankYou)) return null;
  return (
    <div className="flex flex-col gap-2">
      {offers.thankYou ? (
        // A paid invoice (2026-10-16): a thank-you, with the review ask inside only when every
        // review rule allows it. The server decides; the button is the same either way.
        <form action={sayThanksAction}>
          <input type="hidden" name="threadId" value={threadId} />
          <PendingButton pending="Writing it…" variant="outline" className={wrap}>
            Say thanks
          </PendingButton>
        </form>
      ) : null}
      {offers.review ? (
        <form action={askForReviewAction}>
          <input type="hidden" name="threadId" value={threadId} />
          <PendingButton pending="Writing it…" variant="outline" className={wrap}>
            Ask for a review
          </PendingButton>
        </form>
      ) : null}
      {offers.closingQuestion ? (
        <form action={askClosingQuestionAction}>
          <input type="hidden" name="threadId" value={threadId} />
          <PendingButton pending="Writing it…" variant="outline" className={wrap}>
            Want to ask if they went another way?
          </PendingButton>
        </form>
      ) : null}
    </div>
  );
}
