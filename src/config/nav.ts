/**
 * The tab bar (outside review, 2026-10-15): five tabs — Queue, Inbox, Quotes, Money, More.
 * More holds the screens listed here, and is marked current on any of them.
 */
export const TAB_PATHS = ["/queue", "/inbox", "/quotes", "/money", "/more"] as const;

export const MORE_PATHS = [
  "/more",
  "/customers",
  "/activity",
  "/settings",
  "/billing",
  "/admin",
  "/record",
] as const;

const under = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Which tab is current for a path, or null (e.g. the welcome screens). */
export function currentTab(path: string): (typeof TAB_PATHS)[number] | null {
  for (const href of TAB_PATHS) if (href !== "/more" && under(path, href)) return href;
  if (MORE_PATHS.some((p) => under(path, p))) return "/more";
  return null;
}
