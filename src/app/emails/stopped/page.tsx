import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { SkipLink } from "@/components/app/skip-link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Emails stopped",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Check 18 P9: the morning email's Unsubscribe link, opened in a browser. Opening it changes
 * nothing (link scanners open URLs too); the button POSTs to the signed link, which checks it.
 */
function DigestStop({ w, s, done }: { w: string; s: string; done: boolean }) {
  if (done) {
    return (
      <>
        <Headline serif="done," heavy="morning email off." />
        <p className="text-lg">
          Morning email turned off. Turn it back on in Settings. Nothing else changed.
        </p>
      </>
    );
  }
  if (!UUID.test(w) || !SIG.test(s)) {
    return (
      <>
        <Headline serif="that link," heavy="didn't work." />
        <p className="text-lg">
          Nothing was changed. To turn off the morning email, sign in and switch it off in Settings
          → Morning email.
        </p>
      </>
    );
  }
  const action = `/api/emails/stop?${new URLSearchParams({ w, s, k: "digest" })}`;
  return (
    <>
      <Headline serif="stop the," heavy="morning email?" />
      <p className="text-lg">
        This turns off the morning email and the short one on the 1st of each month. Nothing else
        changes.
      </p>
      <form action={action} method="post">
        <input type="hidden" name="from" value="page" />
        <Button type="submit" className="w-full">
          Turn off the morning email
        </Button>
      </form>
    </>
  );
}

/**
 * Where "Stop these emails" lands (2026-10-16). Public and static: it shows no account, only
 * whether the link worked. The stop itself happened in /api/emails/stop.
 */
export default async function TrialEmailsStoppedPage(props: PageProps<"/emails/stopped">) {
  const { link, kind, w, s, done } = await props.searchParams;
  const bad = link === "bad";
  const digest = kind === "digest";
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <SkipLink />
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col justify-center gap-6 py-12 outline-none"
      >
        {digest && !bad ? (
          <DigestStop w={str(w)} s={str(s)} done={done === "1"} />
        ) : bad ? (
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
