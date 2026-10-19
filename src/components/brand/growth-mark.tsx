import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";

/**
 * Check 7 P6: Squared Away Growth's one mark, the same on the homepage's Growth bar and the
 * /growth header: the wordmark and a small "growth" chip. One accessible name for the whole
 * thing; the parts are hidden from screen readers.
 */
export function GrowthMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Squared Away Growth"
      className={cn("inline-flex items-end gap-2", className)}
    >
      <span aria-hidden className="inline-flex">
        <Wordmark />
      </span>
      <span
        aria-hidden
        className="rounded-full bg-offwhite px-2 text-sm leading-6 font-black text-charcoal"
      >
        growth
      </span>
    </span>
  );
}
