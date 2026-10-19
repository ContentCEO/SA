import Link from "next/link";
import { GrowthMark } from "@/components/brand/growth-mark";
import { growthCopy } from "./growth-copy";

/**
 * Sticky charcoal bar for the homepage's Growth part. Sticky only inside the Growth wrapper, so
 * it covers the site header there (z-20 over z-10; the header itself is charcoal by then, after
 * the switch). The Growth part runs to the end of the page (the footer below it is shorter than
 * the screen), so the bar stays pinned all the way down and the header doesn't come back: that's
 * intended, don't "fix" it. While the bar is stuck over it, the covered header is made inert
 * (GrowthSwitch), so its links can't take focus under the bar (Check 32 P3).
 * Opaque on purpose: a see-through bar shows the paper header through it as a third grey.
 * A plain div, not <header>, so there's no second banner landmark.
 */
export function GrowthChapterBar() {
  const c = growthCopy.bar;
  return (
    <div className="sticky top-0 z-20 border-b border-ash/40 bg-charcoal px-4 py-2">
      {/* min-h-14: as tall as the paper header (wordmark row), so none of it peeks out below. */}
      <div className="mx-auto flex min-h-14 max-w-5xl items-center justify-between gap-3">
        {/* Check 7 P6: the same mark as /growth's header. */}
        <GrowthMark />
        <nav aria-label={c.nav}>
          <Link
            href="#growth-call"
            className="inline-flex min-h-tap items-center rounded-lg bg-offwhite px-3 font-semibold whitespace-nowrap text-charcoal sm:px-4"
          >
            {c.link}
          </Link>
        </nav>
      </div>
    </div>
  );
}
