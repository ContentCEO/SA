"use client";

import { useEffect, useRef } from "react";
import { announce, findRegion } from "@/lib/announce";
import { cn } from "@/lib/utils";

/**
 * A plain status line. `strong` inverts to charcoal for things that need the
 * owner (errors, blocked states). No red — inversion carries the weight.
 *
 * Check 32 P5: a plain notice is read out through the page's always-present live region
 * (Announcer, in the root layout): after mount it writes its own words there. The visible line
 * keeps role="status" for its meaning but is aria-live="off", so nothing is read twice. A strong
 * notice stays role="alert", which screen readers announce as it appears. When a settings save
 * can't find the control it came from, focus comes here (FocusAfterSave sets tabIndex -1).
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
  const ref = useRef<HTMLParagraphElement>(null);
  const text = typeof children === "string" ? children : null;
  useEffect(() => {
    if (strong) return;
    return announce(findRegion, ref.current?.textContent ?? "");
    // Again when the words change (a second save landing on the same screen).
  }, [strong, text]);
  return (
    <p
      ref={ref}
      role={strong ? "alert" : "status"}
      aria-live={strong ? undefined : "off"}
      data-notice={strong ? "strong" : ""}
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
