import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { SiteFooter } from "@/components/app/site-footer";
import { TermsForm } from "@/components/app/terms-form";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { phoneHref } from "@/lib/phone-href";
import { requireSignedIn } from "@/server/session";
import { termsOf } from "@/server/terms";
import { hasCurrentTerms, safeNextPath, termsScreenCopy } from "@/server/terms-rules";
import { agreeToTermsAction } from "./actions";

export const metadata: Metadata = { title: "Our terms · Squared Away" };

/**
 * Every signed-in screen sends someone here who hasn't agreed to the current terms (Davi,
 * 2026-10-15): accounts from before the "I agree" box, a sign-in that didn't carry it, and
 * everyone once the terms change. Outside the (app) layout on purpose: its header links all lead
 * back here until they agree.
 */
export default async function TermsAgreementPage(props: PageProps<"/welcome/terms">) {
  const { userId } = await requireSignedIn();
  const { next } = await props.searchParams;
  const back = safeNextPath(next);
  const terms = (await termsOf(userId)) ?? { termsVersion: null };
  if (hasCurrentTerms(terms)) redirect(back);
  const copy = termsScreenCopy(terms);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif={copy.serif} heavy={copy.heavy} />
        <p className="text-lg">{copy.lead}</p>
        <TermsForm
          action={agreeToTermsAction}
          submitLabel="Agree and continue"
          pendingLabel="Saving…"
          next={back}
        />
        <section aria-labelledby="disagree" className="flex flex-col gap-3 border-t pt-6">
          <h2 id="disagree" className="text-lg font-black">
            Don&apos;t agree?
          </h2>
          <p className="text-muted-foreground">
            Sign out here. To cancel your plan or delete your account, call or text us at{" "}
            <a
              href={phoneHref("tel", siteConfig.phone)}
              className="font-semibold text-charcoal underline underline-offset-4"
            >
              {siteConfig.phone}
            </a>
            .
          </p>
          <form
            action={async () => {
              "use server";
              // As in Settings: a phone that kept the queue (plan #10) stops keeping it.
              (await cookies()).delete(OFFLINE_COOKIE);
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button type="submit" variant="outline" className="w-full">
              Sign out
            </Button>
          </form>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
