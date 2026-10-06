/**
 * A still of the real Queue, drawn in HTML (not a screenshot) so it stays crisp
 * and on-brand. Decorative: screen readers get one plain sentence instead.
 */
export function QueuePreview() {
  return (
    <figure className="relative mx-auto w-full max-w-sm">
      <figcaption className="sr-only">
        A phone showing the Squared Away queue: a quote request from Dana with a drafted reply and a
        Send reply button, and below it a sent reply marked squared away.
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

        <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-black">Dana Ruiz</span>
            <span className="text-xs text-slate">8 min ago</span>
          </div>
          <span className="text-xs font-semibold">Quote request</span>
          <p>Panel upgrade. Asked for the address and current service size.</p>
          <div className="rounded-lg border bg-paper p-2.5 leading-snug">
            Hey Dana — happy to take a look. What&apos;s the address, and is it 100 or 200 amp
            service right now?
            <br />
            <span className="text-slate">Thanks, Mike</span>
          </div>
          <div className="mt-1 flex h-10 items-center justify-center rounded-lg bg-charcoal font-semibold text-offwhite">
            Send reply
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

        <div className="sa-inverted mt-3 flex flex-col rounded-xl p-4">
          <span className="sa-headline-serif text-xl">reply sent,</span>
          <span className="sa-headline-heavy text-2xl">squared away.</span>
          <span className="mt-1 text-xs text-ash">
            I&apos;ll nudge Priya on Thursday if there&apos;s no reply.
          </span>
        </div>
      </div>
    </figure>
  );
}
