import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";

export const metadata: Metadata = {
  title: "Trial emails stopped",
  robots: { index: false, follow: false },
};

/**
 * Where "Stop these emails" lands (2026-10-16). Public and static: it shows no account, only
 * whether the link worked. The stop itself happened in /api/emails/stop.
 */
export default async function TrialEmailsStoppedPage(props: PageProps<"/emails/stopped">) {
  const { link } = await props.searchParams;
  const bad = link === "bad";
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        {bad ? (
          <>
            <Headline serif="that link," heavy="didn't work." />
            <p className="text-lg">
              Nothing was changed. To stop trial emails, sign in and switch them off in Settings →
              Morning email.
            </p>
          </>
        ) : (
          <>
            <Headline serif="done," heavy="no more trial emails." />
            <p className="text-lg">
              You won&apos;t get any more trial emails from Squared Away. Nothing else changed: your
              account, your drafts and your morning email settings are as they were.
            </p>
            <p className="text-muted-foreground">
              Changed your mind? Sign in and switch them back on in Settings → Morning email.
            </p>
          </>
        )}
        <Link
          href="/signin"
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          Sign in
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
