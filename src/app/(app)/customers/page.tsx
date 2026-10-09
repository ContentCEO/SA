import type { Metadata } from "next";
import { Headline } from "@/components/brand/headline";
import { relativeTime } from "@/lib/relative-time";
import { listCustomers } from "@/server/customers";
import { formatCents } from "@/server/quote-rules";
import { requireOwner } from "@/server/session";
import { CustomerList } from "./customer-list";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage() {
  const { workspace } = await requireOwner();
  const now = new Date();
  const customers = await listCustomers(workspace.id, now);

  return (
    <>
      <Headline serif="who you work for," heavy="customers." />
      <p className="text-muted-foreground">
        Everyone who&apos;s emailed your business, built from your inbox. Junk mail is left out.
      </p>
      {customers.length ? (
        <CustomerList
          items={customers.map((c) => ({
            key: c.key,
            name: c.name ?? c.address,
            address: c.address,
            line: `${c.conversations} conversation${c.conversations === 1 ? "" : "s"}${
              c.lastContactAt ? ` · last ${relativeTime(c.lastContactAt, now)}` : ""
            }${c.isSupplier ? " · supplier" : ""}`,
            facts: [
              c.openQuotes ? `${c.openQuotes} open quote${c.openQuotes === 1 ? "" : "s"}` : null,
              c.wonCents ? `Won ${formatCents(c.wonCents)}` : null,
            ].filter((f): f is string => !!f),
          }))}
        />
      ) : (
        <p className="text-lg">No customers yet. They appear here once your mail has been read.</p>
      )}
    </>
  );
}
