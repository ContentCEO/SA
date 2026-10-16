"use client";

import { useEffect, useRef, useState } from "react";
import { matchesSearch } from "@/server/inbox-rules";

/** One inbox row: its server-rendered `<li>`, the text a search looks through, and junk or not. */
export type InboxSearchRow = { id: string; text: string; junk: boolean; node: React.ReactNode };

/**
 * Inbox search and the folded junk line (outside review). Filters on the phone, so what's
 * typed never goes into a URL or a server log. Junk sits in one "N junk emails" line at the
 * end; while searching, matching junk shows in the list with everything else.
 */
export function InboxSearch({ rows }: { rows: InboxSearchRow[] }) {
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
      {found ? (
        found.length ? (
          list(found)
        ) : (
          <p role="status" className="text-lg">
            No emails match that.
          </p>
        )
      ) : (
        <>
          {main.length ? list(main) : null}
          {junk.length ? (
            <details className="rounded-xl border">
              <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                {junk.length} junk email{junk.length === 1 ? "" : "s"}
              </summary>
              {list(junk, "flex flex-col gap-3 px-3 pb-3")}
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
