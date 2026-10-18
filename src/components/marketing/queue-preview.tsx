import { pricing } from "@/config/pricing";
import { dayAdjective } from "@/lib/trial-words";

/**
 * A still of the real Queue, drawn in HTML (not a screenshot) so it stays crisp and on-brand.
 * Check 6 P4: it shows the main action, Send reply, laid out as the real draft card lays it out
 * (Send reply across the card, Edit and Discard under it). The trial rule is said once, in the
 * caption under the phone. Decorative: screen readers get one plain sentence instead.
 */
export function QueuePreview() {
  const trial = dayAdjective(pricing.evaluationDays);
  return (
    <figure className="relative mx-auto w-full max-w-sm">
      <figcaption className="sr-only">
        An example of the Squared Away queue: a quote request from Dana with a drafted reply and a
        Send reply button. During the {trial} trial, Squared Away won&apos;t send anything to a
        customer.
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
          <span className="text-xs font-semibold">Queue · Inbox · Quotes · Money</span>
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

        <div className="mt-3 flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-black">Priya Shah</span>
            <span className="text-xs text-slate">1 hr ago</span>
          </div>
          <span className="text-xs font-semibold">Scheduling</span>
          <p>Wants to move Thursday&apos;s visit. Draft asks which day suits her.</p>
        </div>
      </div>
      {/* The figcaption above says this for screen readers. */}
      <p aria-hidden className="mt-4 text-center text-slate">
        Example. During your {trial} trial it drafts like this, but won&apos;t send to a customer.
      </p>
    </figure>
  );
}
