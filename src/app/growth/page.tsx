import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Wordmark } from "@/components/brand/wordmark";
import { SiteAnalytics } from "@/components/marketing/site-analytics";
import { GrowthChapter } from "@/components/marketing/growth/growth-chapter";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { SkipLink } from "@/components/app/skip-link";

const { meta, page } = growthCopy;

// The share card is this folder's own opengraph-image / twitter-image (Growth's words), which
// file-based metadata attaches to this page.
export const metadata: Metadata = {
  title: { absolute: meta.title },
  description: meta.description,
  alternates: { canonical: "/growth" },
  openGraph: {
    type: "website",
    siteName: "Squared Away",
    title: meta.title,
    description: meta.description,
  },
  twitter: {
    card: "summary_large_image",
    title: meta.title,
    description: meta.twitterDescription,
  },
};

/**
 * Squared Away Growth on its own page (where ads and links land). Public and static: no
 * sign-in check, so owners who are signed in can open it too. Charcoal edge to edge.
 */
export default function GrowthPage() {
  return (
    <div data-growth-page className="sa-inverted flex flex-1 flex-col">
      <SkipLink />
      <header className="sticky top-0 z-10 border-b border-ash/40 bg-charcoal px-4">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between py-2">
          <Link href="/" className="inline-flex min-h-tap items-center" aria-label={page.homeLabel}>
            <Wordmark />
          </Link>
          <nav aria-label="Site" className="flex items-center gap-1">
            <Link href="/" className="inline-flex min-h-tap items-center px-3 font-semibold">
              {page.appLink}
            </Link>
            <Link
              href="#growth-call"
              className="inline-flex min-h-tap items-center rounded-lg bg-offwhite px-4 font-semibold text-charcoal"
            >
              {page.callLink}
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex flex-col outline-none">
        <GrowthChapter headingLevel="h1" standalone />
      </main>
      <div className="mx-auto w-full max-w-5xl px-4 pb-6">
        <SiteFooter />
      </div>
      <SiteAnalytics />
    </div>
  );
}
