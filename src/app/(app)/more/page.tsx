import type { Metadata } from "next";
import { MenuList, type MenuItem } from "@/components/app/menu-list";
import { Headline } from "@/components/brand/headline";
import { isAdminEmail } from "@/server/admin";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: "More" };

/** The fifth tab: everything that isn't Queue, Inbox, Quotes or Money. */
export default async function MorePage() {
  const { session } = await requireOwner();
  const items: MenuItem[] = [
    { href: "/customers", label: "Customers", line: "Everyone who's emailed your business." },
    { href: "/activity", label: "Activity", line: "What was won, paid and sent this month." },
    { href: "/settings", label: "Settings", line: "Your Gmail, business, voice and alerts." },
  ];
  if (isAdminEmail(session?.user?.email)) {
    items.push({ href: "/admin", label: "Admin", line: "Accounts, invites and payments." });
  }
  return (
    <>
      <Headline serif="everything else," heavy="more." />
      <MenuList label="More" items={items} />
    </>
  );
}
