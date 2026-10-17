"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { matchesSearch } from "@/server/inbox-rules";

/** One inbox row: its server-rendered `<li>`, the text a search looks through, and junk or not. */
export type InboxSearchRow = { id: string; text: string; junk: boolean; node: React.ReactNode };

/**
 * Inbox search and the folded junk line (outside review). Filters on the phone, so what's
 * typed never goes into a URL or a server log. Junk sits in one "N junk emails" line at the
 * end; while searching, matching junk shows in the list with everything else.
 */
export function InboxSearch({
  rows,
  junkCount,
  olderHref,
}: {
  rows: InboxSearchRow[];
  /** Check 10 P2: all folded junk (the line may hold only the newest few). */
  junkCount?: number;
  /** Check 10 P2: the next page, when this one was full. */
  olderHref?: string | null;
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Anything typed before the page finished loading (slow signal) still filters.
  useEffect(() => {
    if (input.current?.value) setQ(input.current.value);
  }, []);
  const query = q.trim();
  const main = rows.filter((r) => !r.junk);
  const junk = rows.filter((r) => r.junk);
  const found = query ? rows.filter((r) => matchesSearch(r.text, query)) : null;
  const list = (items: InboxSearchRow[], className = "flex flex-col gap-3") => (
    <ul className={className}>{items.map((r) => r.node)}</ul>
  );
  const junkTotal = Math.max(junkCount ?? 0, junk.length);
  const older = olderHref ? (
    <Link
      href={olderHref}
      className="inline-flex min-h-tap w-full items-center justify-center rounded-lg border-2 border-current px-4 font-semibold"
    >
      Show older emails
    </Link>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-semibold">
        Search your inbox
        <input
          type="search"
          ref={input}
          onInput={(e) => setQ(e.currentTarget.value)}
          placeholder="Name, email or what it's about"
          className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base font-normal"
        />
      </label>
      {/* Check 10 P2: say what a search looks through. */}
      <p className="text-sm text-muted-foreground">
        Searching the {rows.length} email{rows.length === 1 ? "" : "s"} on this page.
      </p>
      {found ? (
        found.length ? (
          list(found)
        ) : (
          <div className="flex flex-col gap-3">
            <p role="status" className="text-lg">
              No emails match that.
            </p>
            {older}
          </div>
        )
      ) : (
        <>
          {main.length ? list(main) : null}
          {junk.length ? (
            <details className="rounded-xl border">
              <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                {junkTotal} junk email{junkTotal === 1 ? "" : "s"}
              </summary>
              {list(junk, "flex flex-col gap-3 px-3 pb-3")}
            </details>
          ) : null}
          {older}
        </>
      )}
    </div>
  );
}
