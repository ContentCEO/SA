"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

export type CustomerGroup = "customers" | "suppliers" | "towns" | "crew";

export type CustomerListItem = {
  key: string;
  name: string;
  address: string;
  line: string;
  facts: string[];
  group: CustomerGroup;
};

/** Check 13 P1: the three groups kept apart from customers, in the order the links show. */
const OTHER_GROUPS: { group: Exclude<CustomerGroup, "customers">; label: string }[] = [
  { group: "suppliers", label: "Suppliers" },
  { group: "towns", label: "Towns and inspectors" },
  { group: "crew", label: "Your crew and subs" },
];

/** Check 13 P3: rows drawn at a time; search still filters everyone. */
const PAGE = 50;

/** Filters on the phone, so names never go into a URL or a server log. */
export function CustomerList({
  items,
  group = "customers",
}: {
  items: CustomerListItem[];
  group?: CustomerGroup;
}) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const input = useRef<HTMLInputElement>(null);
  // Uncontrolled, and read once on load: anything typed before the page finished
  // loading (slow signal) still filters.
  useEffect(() => {
    if (input.current?.value) setQ(input.current.value);
  }, []);
  const counts = useMemo(() => {
    const c: Record<CustomerGroup, number> = { customers: 0, suppliers: 0, towns: 0, crew: 0 };
    for (const i of items) c[i.group]++;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const inGroup = items.filter((c) => c.group === group);
    return t
      ? inGroup.filter((c) => c.name.toLowerCase().includes(t) || c.address.includes(t))
      : inGroup;
  }, [items, q, group]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-semibold">
        {group === "customers" ? "Find a customer" : "Find someone"}
        <input
          type="search"
          ref={input}
          onInput={(e) => setQ(e.currentTarget.value)}
          placeholder="Name or email"
          className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base font-normal"
        />
      </label>
      <nav aria-label="Other people" className="flex flex-wrap gap-x-4">
        {group !== "customers" ? (
          <Link
            href="/customers"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            Customers ({counts.customers})
          </Link>
        ) : null}
        {OTHER_GROUPS.filter((g) => g.group !== group).map((g) => (
          <Link
            key={g.group}
            href={`/customers?group=${g.group}`}
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            {g.label} ({counts[g.group]})
          </Link>
        ))}
      </nav>
      {group !== "customers" ? (
        <h2 className="text-xl font-black">{OTHER_GROUPS.find((g) => g.group === group)?.label}</h2>
      ) : null}
      <ul className="flex flex-col divide-y divide-stone rounded-xl border bg-card">
        {shown.slice(0, limit).map((c) => (
          <li key={c.key}>
            <Link href={`/customers/${c.key}`} className="flex min-h-tap flex-col gap-0.5 p-4">
              <span className="truncate text-lg font-black">{c.name}</span>
              <span className="text-muted-foreground">{c.line}</span>
              {c.facts.length ? <span className="font-semibold">{c.facts.join(" · ")}</span> : null}
            </Link>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="p-4">{q.trim() ? "No one matches that." : "No one here yet."}</li>
        ) : null}
      </ul>
      {shown.length > limit ? (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="min-h-tap rounded-lg border border-input bg-paper px-4 font-semibold"
        >
          Show {PAGE} more
        </button>
      ) : null}
    </div>
  );
}
