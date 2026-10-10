"use client";

import { Activity, ClipboardCheck, Inbox, Receipt, Settings, Sun, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand/wordmark";
import { cn } from "@/lib/utils";
import { toggleSunlightAction } from "@/app/(app)/settings/device-actions";

const NAV = [
  { href: "/queue", label: "Queue", Icon: ClipboardCheck },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
  { href: "/quotes", label: "Quotes", Icon: Receipt },
  { href: "/customers", label: "Customers", Icon: Users },
  { href: "/activity", label: "Activity", Icon: Activity },
  { href: "/settings", label: "Settings", Icon: Settings },
] as const;

/**
 * Phones get a bottom tab bar (thumb reach, one hand); wider screens get the
 * same links in the header. Only one of the two is ever visible.
 */
export function AppHeader({ sunlight = false }: { sunlight?: boolean }) {
  const path = usePathname();
  const current = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <>
      <header className="flex items-center justify-between">
        <Link href="/queue" className="inline-flex min-h-tap items-center rounded-md">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-1">
          <nav aria-label="Main" className="hidden items-center sm:flex">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
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
          <form action={toggleSunlightAction}>
            <button
              type="submit"
              aria-pressed={sunlight}
              className={cn(
                "inline-flex min-h-tap min-w-tap items-center justify-center gap-1.5 rounded-md px-2 font-semibold",
                sunlight && "sa-inverted font-black",
              )}
            >
              <Sun aria-hidden className="size-5" strokeWidth={sunlight ? 2.75 : 2} />
              {/* Words on phones (room to spare); icon only beside the full nav. */}
              <span className="sm:sr-only">Sunlight</span>
            </button>
          </form>
        </div>
      </header>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-stone bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-6">
          {NAV.map(({ href, label, Icon }) => {
            const on = current(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold",
                    on && "font-black",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-11 items-center justify-center rounded-full",
                      on && "sa-inverted",
                    )}
                  >
                    <Icon aria-hidden className="size-5" strokeWidth={on ? 2.5 : 2} />
                  </span>
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
