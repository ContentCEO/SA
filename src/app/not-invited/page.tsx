import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { siteConfig } from "@/config/site";

export default function NotInvitedPage() {
  const support = process.env.SUPPORT_EMAIL;
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif="not quite yet," heavy="invite only." />
        <p className="text-lg text-muted-foreground">
          Squared Away is invite-only right now. We set up each shop by hand so it works properly
          from day one.
        </p>
        <p className="text-lg">
          If you think you&apos;ve been invited, sign in with the same email address the invite went
          to. Otherwise, join the waitlist and we&apos;ll be in touch — or call{" "}
          {siteConfig.operator} at {siteConfig.phone}
          {support ? ` or email ${support}` : ""}.
        </p>
        <Link
          href="/#waitlist"
          className="inline-flex min-h-tap items-center justify-center rounded-lg bg-primary px-5 font-semibold text-primary-foreground"
        >
          Join the waitlist
        </Link>
        <Link
          href="/signin"
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          Try a different account
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
