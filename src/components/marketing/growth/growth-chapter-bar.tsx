import Link from "next/link";
import { growthCopy } from "./growth-copy";

/**
 * Sticky charcoal bar for the homepage's Growth chapter. Sticky only inside the chapter
 * wrapper, so it covers the paper header there (z-20 over z-10). The chapter runs to the end of
 * the page (the footer below it is shorter than the screen), so the bar stays pinned all the way
 * down and the paper header doesn't come back: that's intended, don't "fix" it.
 * Opaque on purpose: a see-through bar shows the paper header through it as a third grey.
 * A plain div, not <header>, so there's no second banner landmark.
 */
export function GrowthChapterBar() {
  const c = growthCopy.bar;
  return (
    <div className="sticky top-0 z-20 border-b border-ash/40 bg-charcoal px-4 py-2">
      {/* min-h-14: as tall as the paper header (wordmark row), so none of it peeks out below. */}
      <div className="mx-auto flex min-h-14 max-w-5xl items-center justify-between gap-3">
        <p className="font-black" aria-hidden>
          {c.label}
        </p>
        <nav aria-label={c.nav}>
          <Link
            href="#growth-call"
            className="inline-flex min-h-tap items-center rounded-lg bg-offwhite px-4 font-semibold text-charcoal"
          >
            {c.link}
          </Link>
        </nav>
      </div>
    </div>
  );
}
