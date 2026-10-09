/**
 * Shown the instant a tab is tapped, while the screen's data loads — so a
 * weak signal feels like "loading", not "frozen". Plain blocks, no spinner.
 */
export function ScreenSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <div className="h-8 w-2/3 animate-pulse rounded-md bg-stone/60 motion-reduce:animate-none" />
      <div className="h-10 w-1/2 animate-pulse rounded-md bg-stone/60 motion-reduce:animate-none" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-xl bg-stone/40 motion-reduce:animate-none"
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
