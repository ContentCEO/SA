import { Headline } from "@/components/brand/headline";
import { siteConfig } from "@/config/site";

/**
 * "Who's behind this" — facts Davi gave us, nothing more. No testimonials, no
 * numbers, no license wording or number until Davi confirms them (Massachusetts
 * uses a Construction Supervisor License; don't write "GC"). No pronouns for Davi
 * and never "builder" (tests/unit/about-davi.test.ts).
 */
export function AboutDavi() {
  return (
    <section aria-label="Who's behind this" className="border-t border-stone px-4 py-16 sm:py-24">
      <div className="mx-auto grid w-full max-w-5xl items-center gap-10 md:grid-cols-[minmax(0,14rem)_1fr]">
        {/*
          PHOTO SPOT — waiting on Davi's own photo (no stock photos).
          Replace this placeholder with <Image src="/brand/davi.jpg" … /> when it arrives.
        */}
        <div
          data-photo-placeholder
          className="flex aspect-square w-full max-w-48 items-center justify-center rounded-2xl border-2 border-dashed border-charcoal p-6 text-center"
        >
          <span className="font-semibold text-slate">Photo of Davi coming soon</span>
        </div>
        <div className="flex flex-col gap-4">
          <Headline as="h2" serif="who's behind this," heavy="someone in the trades." />
          <p className="max-w-2xl text-xl leading-relaxed">
            Squared Away is built by {siteConfig.operator}, who runs A&amp;C Construction, a
            remodeling company in Massachusetts: framing, roofs, additions and finish work. It began
            as the tool for A&amp;C Construction&apos;s own inbox.
          </p>
          {/* LICENSE LINE — add only the exact wording Davi confirms (no license number yet). */}
        </div>
      </div>
    </section>
  );
}
