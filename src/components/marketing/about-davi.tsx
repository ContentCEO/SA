import Image from "next/image";
import { Headline } from "@/components/brand/headline";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * "Who's behind this" — facts Davi gave us, nothing more. No testimonials, no
 * numbers, no license wording or number until Davi confirms them (Massachusetts
 * uses a Construction Supervisor License; don't write "GC"). No pronouns for Davi
 * and never "builder" (tests/unit/about-davi.test.ts).
 */
/**
 * Davi's own photo (no stock photos). Until the file exists the section is one column, story text
 * only: no placeholder box. When it arrives: put it in public/brand/ and set it here.
 */
const photo: { src: string; alt: string } | null = null;

export function AboutDavi() {
  return (
    <section aria-label="Who's behind this" className="border-t border-stone px-4 py-16 sm:py-24">
      <div
        className={cn(
          "mx-auto grid w-full max-w-5xl items-center gap-10",
          photo && "md:grid-cols-[minmax(0,14rem)_1fr]",
        )}
      >
        {photo ? (
          <Image
            src={photo.src}
            alt={photo.alt}
            width={448}
            height={448}
            className="aspect-square w-full max-w-48 rounded-2xl object-cover"
          />
        ) : null}
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
