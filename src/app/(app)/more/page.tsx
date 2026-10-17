import type { Metadata } from "next";
import { GrowthMention } from "@/components/app/growth-mention";
import { MenuList, type MenuItem } from "@/components/app/menu-list";
import { Headline } from "@/components/brand/headline";
import { isAdminEmail } from "@/server/admin";
import { portalClient } from "@/server/growth-clients";
import { jobsAllowed } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: "More" };

/** The fifth tab: everything that isn't Queue, Inbox, Quotes or Money. */
export default async function MorePage() {
  const { session, workspace } = await requireOwner();
  const growthClient = await portalClient(workspace.id);
  const items: MenuItem[] = [
    { href: "/customers", label: "Customers", line: "Everyone who's emailed your business." },
    { href: "/activity", label: "Activity", line: "What was won, paid and sent this month." },
    { href: "/settings", label: "Settings", line: "Your Gmail, business, voice and alerts." },
  ];
  // Squared Away Growth: a client's way to their dashboard (read from growth_clients only).
  if (growthClient) {
    items.push({
      href: "/my-growth",
      label: "Growth",
      line: "Your Growth dashboard: numbers and updates.",
    });
  }
  if (isAdminEmail(session?.user?.email)) {
    items.push({ href: "/admin", label: "Admin", line: "Accounts, invites and payments." });
  }
  return (
    <>
      <Headline serif="everything else," heavy="more." />
      <MenuList label="More" items={items} />
      {/* Never on a read-only or expired account's screens (Davi's review, 2026-10-16). */}
      {jobsAllowed(workspace, new Date()) ? <GrowthMention /> : null}
    </>
  );
}
