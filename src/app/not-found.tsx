import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";

export const metadata: Metadata = { title: "Page not found · Squared Away" };

/** Any address we don't have (and every 404, /admin's included): plain words and a way home. */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link
          href="/"
          className="inline-flex min-h-tap items-center"
          aria-label="Squared Away home"
        >
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif="nothing here," heavy="page not found." />
        <p className="text-lg">This address doesn&apos;t go anywhere. It may have been mistyped.</p>
        <Link
          href="/"
          className="inline-flex min-h-tap items-center justify-center self-start rounded-lg bg-charcoal px-5 font-semibold text-offwhite"
        >
          Go to the homepage
        </Link>
      </main>
    </div>
  );
}
