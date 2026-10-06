import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";

export const metadata: Metadata = { title: "Account deleted · Squared Away" };

export default function GoodbyePage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif="all deleted," heavy="squared away." />
        <p className="text-lg">
          Your account and everything in it is gone, and our access to your Gmail has been removed.
        </p>
        <p className="text-lg text-muted-foreground">
          To double-check, Google lists every app with access at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="font-semibold text-charcoal underline underline-offset-4"
          >
            myaccount.google.com/permissions
          </a>
          . Thanks for trying Squared Away.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
