import { ChevronRight } from "lucide-react";
import Link from "next/link";

export type MenuItem = {
  href: string;
  label: string;
  /** One plain line under the label: what's set now, or what's there. */
  line?: string | null;
  /** Inverts the row when it needs the owner (e.g. Gmail access lost). */
  needsYou?: boolean;
};

/** A short list of big rows, one per screen (More, Settings). Each row is at least 56px. */
export function MenuList({ items, label }: { items: MenuItem[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
        {items.map((item) => (
          <li key={item.href} className={item.needsYou ? "sa-inverted" : undefined}>
            <Link
              href={item.href}
              className="flex min-h-14 items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-lg font-semibold">{item.label}</span>
                {item.line ? (
                  <span
                    className={
                      item.needsYou ? "font-black break-words" : "break-words text-muted-foreground"
                    }
                  >
                    {item.line}
                  </span>
                ) : null}
              </span>
              <ChevronRight aria-hidden className="size-5 shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
