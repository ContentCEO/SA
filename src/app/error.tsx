"use client";

import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { HelpLine } from "@/components/app/help-line";
import { Button } from "@/components/ui/button";

/**
 * Something broke while showing a page: plain words, a way to try again and a way home. Never
 * the error's message or digest (they can carry what a query was given); Sentry's
 * onRequestError already reports it, so nothing is logged here.
 */
export default function ErrorPage({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    // Check 32 P12: a <main> (landmark and skip-link target) and how to reach us.
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-12 outline-none"
    >
      <Headline serif="sorry about that," heavy="something broke." />
      <p className="text-lg">Something went wrong on our side.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" size="lg" onClick={() => retry()}>
          Try again
        </Button>
        <Link
          href="/"
          className="inline-flex min-h-tap items-center justify-center rounded-lg border-2 border-charcoal px-5 font-semibold"
        >
          Go to the homepage
        </Link>
      </div>
      <HelpLine />
    </main>
  );
}
