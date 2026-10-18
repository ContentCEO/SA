import type { Metadata } from "next";
import { Headline } from "@/components/brand/headline";
import { relativeTime } from "@/lib/relative-time";
import { listCustomers } from "@/server/customers";
import { formatCents } from "@/server/quote-rules";
import { requireOwner } from "@/server/session";
import { CustomerList, type CustomerGroup } from "./customer-list";
import type { CustomerKind } from "@/server/customers";

export const metadata: Metadata = { title: "Customers" };

/** Check 13 P1: each kind's group in the list (the URL carries only the group's name). */
const GROUP_OF: Record<CustomerKind, CustomerGroup> = {
  customer: "customers",
  supplier: "suppliers",
  town: "towns",
  crew: "crew",
};
const GROUPS: readonly CustomerGroup[] = ["customers", "suppliers", "towns", "crew"];

export default async function CustomersPage(props: PageProps<"/customers">) {
  const { workspace } = await requireOwner();
  const { group: rawGroup } = await props.searchParams;
  const group = GROUPS.find((g) => g === rawGroup) ?? "customers";
  const now = new Date();
  const customers = await listCustomers(workspace.id, now);

  return (
    <>
      <Headline serif="who you work for," heavy="customers." />
      <p className="text-muted-foreground">
        People who&apos;ve emailed you about work. Suppliers, towns and your crew are kept apart.
      </p>
      {customers.length ? (
        <CustomerList
          group={group}
          items={customers.map((c) => ({
            key: c.key,
            name: c.name ?? c.address,
            address: c.address,
            line: `${c.conversations} conversation${c.conversations === 1 ? "" : "s"}${
              c.lastContactAt ? ` · last ${relativeTime(c.lastContactAt, now)}` : ""
            }`,
            facts: [
              c.openQuotes ? `${c.openQuotes} open quote${c.openQuotes === 1 ? "" : "s"}` : null,
              c.wonCents ? `Won ${formatCents(c.wonCents)}` : null,
            ].filter((f): f is string => !!f),
            group: GROUP_OF[c.kind],
          }))}
        />
      ) : (
        <p className="text-lg">No customers yet. They appear here once your mail has been read.</p>
      )}
    </>
  );
}
