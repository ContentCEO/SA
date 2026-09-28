import { cn } from "@/lib/utils";

/**
 * A plain status line. `strong` inverts to charcoal for things that need the
 * owner (errors, blocked states). No red — inversion carries the weight.
 */
export function Notice({
  children,
  strong = false,
  className,
}: {
  children: React.ReactNode;
  strong?: boolean;
  className?: string;
}) {
  return (
    <p
      role={strong ? "alert" : "status"}
      className={cn(
        "rounded-lg px-4 py-3 text-base",
        strong ? "sa-inverted font-semibold" : "border bg-card",
        className,
      )}
    >
      {children}
    </p>
  );
}
