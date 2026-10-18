"use client";

import { useEffect, useRef } from "react";

/**
 * Check 10 P9: the filter chips. On phones they sit in one sideways row with a soft fade at the
 * right edge (theme tokens only) and the active chip scrolled into view; from `sm` up they wrap,
 * so every chip shows at a glance.
 */
export function ChipRow({ children }: { children: React.ReactNode }) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = nav.current;
    const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !active || row.scrollWidth <= row.clientWidth) return;
    // Only the row moves (never the page): centre the active chip where it fits.
    row.scrollLeft =
      active.offsetLeft - row.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }, []);
  return (
    <div className="relative -mx-4">
      <nav
        ref={nav}
        aria-label="Filter"
        className="flex gap-2 overflow-x-auto px-4 pb-1 sm:flex-wrap sm:overflow-visible"
      >
        {children}
      </nav>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-background to-transparent sm:hidden"
      />
    </div>
  );
}
