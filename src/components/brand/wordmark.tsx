import { cn } from "@/lib/utils";

/**
 * Placeholder stacked wordmark. Swap for the SVG from Davi's icon pack
 * once it lands in public/brand/.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-col leading-none", className)} aria-label="Squared Away">
      <span className="sa-headline-serif text-lg" aria-hidden>
        squared
      </span>
      <span className="sa-headline-heavy text-xl" aria-hidden>
        away.
      </span>
    </span>
  );
}
