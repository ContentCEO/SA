import { growthCopy } from "./growth-copy";

/** Paper introduction to Squared Away Growth, before any colour change. `#growth` lands here. */
export function GrowthBridge() {
  const c = growthCopy.bridge;
  return (
    <section
      id="growth"
      aria-label={c.region}
      className="scroll-mt-20 border-t border-stone px-4 pt-16 pb-10 sm:pt-24"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col">
        <p className="flex flex-col">
          <span className="sa-headline-serif text-3xl sm:text-4xl">{c.serif}</span>
          <span className="sa-headline-heavy text-3xl sm:text-4xl">{c.heavy}</span>
        </p>
        <p className="mt-4 max-w-2xl text-lg text-slate">{c.body}</p>
      </div>
    </section>
  );
}

/**
 * The paper → charcoal wipe: a full-bleed band whose charcoal ink rises as it scrolls into
 * view (CSS scroll timeline, src/styles/theme.css). No text, no JavaScript. Without
 * scroll-driven animations, or with reduced motion, the band is simply charcoal.
 */
export function GrowthWipe() {
  return (
    <div aria-hidden className="sa-flip">
      <div className="sa-flip-ink" />
    </div>
  );
}
