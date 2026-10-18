import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Check 13 P9: a customer's name on a Queue, Quotes or Money card, linked to their Customers
 * page when there is one. The link carries only the opaque key (a message id), never an
 * address; the tap target is 44px tall and only the name is underlined.
 */
export function CustomerName({
  name,
  customerKey,
  id,
  className,
}: {
  name: string;
  customerKey: string | null;
  id?: string;
  className?: string;
}) {
  if (!customerKey)
    return (
      <span id={id} className={cn("min-w-0 truncate", className)}>
        {name}
      </span>
    );
  return (
    <Link
      id={id}
      href={`/customers/${customerKey}`}
      className={cn("inline-flex min-h-tap min-w-0 items-center", className)}
    >
      <span className="truncate underline underline-offset-4">{name}</span>
    </Link>
  );
}
