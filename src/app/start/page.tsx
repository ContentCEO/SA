import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { portalCopy } from "@/components/growth-portal/portal-copy";
import { portalClient } from "@/server/growth-clients";
import { requireOwner } from "@/server/session";
import { SkipLink } from "@/components/app/skip-link";

export const metadata: Metadata = { title: portalCopy.start.title, robots: { index: false } };

const c = portalCopy.start;

/**
 * Where sign-in lands (Squared Away Growth, 2026-10-16). An active or paused Growth client
 * picks the inbox or the Growth dashboard; everyone else goes straight on to /queue, as before.
 * Behind sign-in and the current terms (requireOwner) like every signed-in screen.
 */
export default async function StartPage() {
  const { workspace } = await requireOwner();
  const client = await portalClient(workspace.id);
  if (!client) redirect("/queue");
  // Growth reads nothing from the inbox app (not even whether Gmail is connected): /queue
  // itself shows one big Connect Gmail to someone who never connected it.
  const choices = [
    { href: "/queue", label: c.inbox, line: c.inboxLine },
    { href: "/my-growth", label: c.growth, line: c.growthLine },
  ];
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-4 pt-6 pb-10">
      <SkipLink />
      <header>
        <Wordmark />
      </header>
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col gap-6 outline-none">
        <Headline serif={c.serif} heavy={c.heavy} />
        <nav aria-label="Choose" className="flex flex-col gap-4">
          {choices.map((choice, i) => (
            <Link
              key={choice.href}
              href={choice.href}
              className={
                i === 0
                  ? "flex min-h-24 items-center gap-3 rounded-2xl border-2 border-charcoal bg-card px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  : "sa-inverted flex min-h-24 items-center gap-3 rounded-2xl px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              }
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-2xl font-black">{choice.label}</span>
                <span className="text-lg">{choice.line}</span>
              </span>
              <ChevronRight aria-hidden className="size-6 shrink-0" />
            </Link>
          ))}
        </nav>
      </main>
      <SiteFooter />
    </div>
  );
}
