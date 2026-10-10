"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

export type CustomerListItem = {
  key: string;
  name: string;
  address: string;
  line: string;
  facts: string[];
};

/** Filters on the phone, so names never go into a URL or a server log. */
export function CustomerList({ items }: { items: CustomerListItem[] }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Uncontrolled, and read once on load: anything typed before the page finished
  // loading (slow signal) still filters.
  useEffect(() => {
    if (input.current?.value) setQ(input.current.value);
  }, []);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t
      ? items.filter((c) => c.name.toLowerCase().includes(t) || c.address.includes(t))
      : items;
  }, [items, q]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-semibold">
        Find a customer
        <input
          type="search"
          ref={input}
          onInput={(e) => setQ(e.currentTarget.value)}
          placeholder="Name or email"
          className="min-h-tap rounded-lg border bg-card px-3 text-base font-normal"
        />
      </label>
      <ul className="flex flex-col divide-y divide-stone rounded-xl border bg-card">
        {shown.map((c) => (
          <li key={c.key}>
            <Link href={`/customers/${c.key}`} className="flex min-h-tap flex-col gap-0.5 p-4">
              <span className="truncate text-lg font-black">{c.name}</span>
              <span className="text-muted-foreground">{c.line}</span>
              {c.facts.length ? <span className="font-semibold">{c.facts.join(" · ")}</span> : null}
            </Link>
          </li>
        ))}
        {shown.length === 0 ? <li className="p-4">No one matches that.</li> : null}
      </ul>
    </div>
  );
}
