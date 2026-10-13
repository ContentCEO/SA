/**
 * A still of the real Queue during the three-day trial, drawn in HTML (not a
 * screenshot) so it stays crisp and on-brand. Wording matches the app: the
 * StatusBanner clock and the card's sending-off note (sendingOffLabel /
 * sendingBlockedReason in src/server/lifecycle.ts). Decorative: screen readers
 * get one plain sentence instead.
 */
export function QueuePreview() {
  return (
    <figure className="relative mx-auto w-full max-w-sm">
      <figcaption className="sr-only">
        A phone showing the Squared Away queue on day 1 of the three-day trial: a quote request from
        Dana with a drafted reply, and a note that sending is off during the three days.
      </figcaption>
      <div
        aria-hidden
        className="rounded-[2.25rem] border-[10px] border-charcoal bg-paper p-4 shadow-[0_30px_60px_-20px_rgba(27,27,27,0.45)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="flex flex-col leading-none">
            <span className="sa-headline-serif text-sm">squared</span>
            <span className="sa-headline-heavy text-base">away.</span>
          </span>
          <span className="text-xs font-semibold">Queue · Inbox · Activity</span>
        </div>

        <div className="mb-3 flex flex-col rounded-xl border-2 border-charcoal px-3 py-2 text-sm">
          <span className="font-black">Day 1 of 3 · 2 days left</span>
          <span className="text-xs">
            Squared Away is reading and drafting, but nothing sends during your three days.
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-black">Dana Ruiz</span>
            <span className="text-xs text-slate">8 min ago</span>
          </div>
          <span className="text-xs font-semibold">Quote request</span>
          <p>Deck repair. Asked for the address and a couple of photos.</p>
          <div className="rounded-lg border bg-paper p-2.5 leading-snug">
            Hey Dana — happy to take a look. What&apos;s the address, and could you send a couple of
            photos of the deck?
            <br />
            <span className="text-slate">Thanks, Mike</span>
          </div>
          <div className="sa-inverted mt-1 flex flex-col justify-center rounded-lg px-3 py-2">
            <span className="font-black">Sending is off during your three days</span>
            <span className="text-xs text-ash">
              Read the drafts and see if they sound like you.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex h-9 items-center justify-center rounded-lg border font-semibold">
              Edit
            </div>
            <div className="flex h-9 items-center justify-center rounded-lg border font-semibold">
              Discard
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-black">Priya Shah</span>
            <span className="text-xs text-slate">1 hr ago</span>
          </div>
          <span className="text-xs font-semibold">Scheduling</span>
          <p>Wants to move Thursday&apos;s visit. Draft asks which day suits her.</p>
        </div>
      </div>
    </figure>
  );
}
