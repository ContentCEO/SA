import type { Metadata } from "next";
import { Headline } from "@/components/brand/headline";
import { firstConnectedAt, listCustomers } from "@/server/customers";
import { customerFactsLine, listStartsOn, wroteWords } from "@/server/customer-rules";
import { getBusinessProfile } from "@/server/profile";
import { BACKFILL_DAYS } from "@/server/sync";
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
  const [customers, profile, connected] = await Promise.all([
    listCustomers(workspace.id, now),
    getBusinessProfile(workspace.id),
    firstConnectedAt(workspace.id),
  ]);
  const tz = profile?.timeZone ?? "America/New_York";
  // Check 13 P8: how far back the list reaches.
  const since = listStartsOn(connected, BACKFILL_DAYS, tz);
  // Check 13 P3: how many customers there are, so the owner knows the size of the list.
  const count = customers.filter((c) => c.kind === "customer").length;

  return (
    <>
      <Headline serif="who you work for," heavy="customers." />
      {customers.length ? (
        <p className="font-semibold">
          {count} customer{count === 1 ? "" : "s"}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        People who&apos;ve emailed you about work. Suppliers, towns and your crew are kept apart.
      </p>
      {since ? (
        <p className="text-sm text-muted-foreground">
          From email since {since}, {BACKFILL_DAYS} days before you connected Gmail. People you
          emailed first show up once they write back.
        </p>
      ) : null}
      {customers.length ? (
        <CustomerList
          group={group}
          since={since}
          items={customers.map((c) => ({
            key: c.key,
            name: c.name ?? c.address,
            address: c.address,
            // Check 13 P6: "2 conversations · wrote 3 hours ago" — their own newest email.
            line: `${c.conversations} conversation${c.conversations === 1 ? "" : "s"}${
              c.lastWroteAt ? ` · ${wroteWords(c.lastWroteAt, now, tz).toLowerCase()}` : ""
            }`,
            facts: customerFactsLine(c)
              .split(" · ")
              .filter((f) => !!f),
            group: GROUP_OF[c.kind],
          }))}
        />
      ) : (
        <p className="text-lg">No customers yet. They appear here once your mail has been read.</p>
      )}
    </>
  );
}
