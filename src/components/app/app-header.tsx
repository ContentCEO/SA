"use client";

import { Banknote, ClipboardCheck, Inbox, Menu, Receipt } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Wordmark } from "@/components/brand/wordmark";
import { cn } from "@/lib/utils";
import { SunlightButton } from "@/components/app/sunlight-button";
import { currentTab } from "@/config/nav";

/** Five tabs (outside review, 2026-10-15): Money owed is a tab; the rest live under More. */
const NAV = [
  { href: "/queue", label: "Queue", Icon: ClipboardCheck },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
  { href: "/quotes", label: "Quotes", Icon: Receipt },
  { href: "/money", label: "Money", Icon: Banknote },
  { href: "/more", label: "More", Icon: Menu },
] as const;

/**
 * Phones get a bottom tab bar (thumb reach, one hand); wider screens get the
 * same links in the header. Only one of the two is ever visible.
 */
export function AppHeader({ sunlight = false }: { sunlight?: boolean }) {
  const path = usePathname();
  const tab = currentTab(path);
  const current = (href: string) => tab === href;
  const router = useRouter();
  /**
   * Check 8 P3: tapping the tab you're already on goes to the top and fetches the list again,
   * as in every phone app (a plain link would refresh but leave you scrolled down).
   */
  const again = (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    // With a notice or a card in the address (?done=, #t-…), the tap goes to the plain screen.
    if (path !== href || location.search || location.hash) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    router.refresh();
  };

  return (
    <>
      {/* Wraps (Sunlight drops below the logo) only at a very big text setting (Check 8 P5). */}
      <header className="flex flex-wrap items-center justify-between gap-x-2">
        <Link href="/queue" className="inline-flex min-h-tap items-center rounded-md">
          <Wordmark />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <nav aria-label="Main" className="hidden items-center sm:flex">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                onClick={again(href)}
                aria-current={current(href) ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-tap items-center px-2 font-semibold underline-offset-8",
                  current(href) && "font-black underline decoration-2",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
          {/* Plan #37: easier to read outdoors. Remembered on this device. */}
          <SunlightButton initial={sunlight} />
        </div>
      </header>
      {/* data-tabbar: theme.css pads focus scrolling above this bar on phones (Check 32 P2). */}
      <nav
        aria-label="Main"
        data-tabbar=""
        className="fixed inset-x-0 bottom-0 z-20 border-t border-stone bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        {/* Check 8 P2: clear of the notch when the phone is sideways (viewport-fit=cover). */}
        <ul className="mx-auto grid max-w-xl grid-cols-5 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
          {NAV.map(({ href, label, Icon }) => {
            const on = current(href);
            return (
              // Check 8 P5: min-w-0 so a big text setting can't push a tab past its fifth.
              <li key={href} className="min-w-0">
                <Link
                  href={href}
                  onClick={again(href)}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "sa-tab flex h-full min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center text-[length:min(0.875rem,3.6vw)] leading-tight font-semibold",
                    on && "font-black",
                  )}
                >
                  <TabPill on={on} Icon={Icon} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/**
 * Check 8 P6: the tapped tab darkens on the tap itself (useLinkStatus is pending until the new
 * screen's history entry lands), not only once the screen has arrived. Must sit inside the Link.
 */
function TabPill({ on, Icon }: { on: boolean; Icon: (typeof NAV)[number]["Icon"] }) {
  const { pending } = useLinkStatus();
  const lit = on || pending;
  return (
    <span
      data-pending={pending ? "" : undefined}
      className={cn(
        "sa-tab-pill flex h-7 w-full max-w-11 shrink-0 items-center justify-center rounded-full",
        lit && "sa-inverted",
      )}
    >
      <Icon aria-hidden className="size-5" strokeWidth={lit ? 2.5 : 2} />
    </span>
  );
}
