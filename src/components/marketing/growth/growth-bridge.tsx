import { growthCopy } from "./growth-copy";

/**
 * Paper introduction to Squared Away Growth: the last section of the app part of the homepage.
 * The next bit of scrolling plays the switch (growth-switch.tsx). No anchor here: `#growth`
 * lands on the Growth opener.
 */
export function GrowthBridge() {
  const c = growthCopy.bridge;
  return (
    <section aria-label={c.region} className="border-t border-stone px-4 pt-16 pb-10 sm:pt-24">
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
