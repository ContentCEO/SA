import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { DeleteAccountButton } from "@/components/app/delete-account-button";
import { DisconnectButton } from "@/components/app/disconnect-button";
import { Notice } from "@/components/app/notice";
import { SiteFooter } from "@/components/app/site-footer";
import { TermsForm } from "@/components/app/terms-form";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { phoneHref } from "@/lib/phone-href";
import { listMailboxes } from "@/server/mailboxes";
import { requireSignedIn } from "@/server/session";
import { termsOf } from "@/server/terms";
import {
  hasCurrentTerms,
  leaveOptionsLine,
  safeNextPath,
  termsScreenCopy,
} from "@/server/terms-rules";
import {
  agreeToTermsAction,
  deleteAccountFromTermsAction,
  disconnectMailboxFromTermsAction,
  openPortalFromTermsAction,
} from "./actions";

export const metadata: Metadata = { title: "Our terms · Squared Away" };

const done: Record<string, string> = {
  disconnected: "Gmail disconnected. We've removed our access at Google.",
};

const errors: Record<string, string> = {
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  delete_billing:
    "We couldn't cancel your plan, so nothing was deleted. Try again, or call us and we'll do it.",
  unknown: "That didn't work. Refresh and try again.",
};

/**
 * Every signed-in screen sends someone here who hasn't agreed to the current terms (Davi,
 * 2026-10-15): accounts from before the "I agree" box, a sign-in that didn't carry it, and
 * everyone once the terms change. Outside the (app) layout on purpose: its header links all lead
 * back here until they agree.
 */
export default async function TermsAgreementPage(props: PageProps<"/welcome/terms">) {
  const { userId, workspace } = await requireSignedIn();
  const { next, done: doneKey, error: errorKey } = await props.searchParams;
  const back = safeNextPath(next);
  const terms = (await termsOf(userId)) ?? { termsVersion: null };
  if (hasCurrentTerms(terms)) redirect(back);
  const copy = termsScreenCopy(terms);
  const mailboxes = await listMailboxes(workspace.id);
  const doneMsg = typeof doneKey === "string" ? done[doneKey] : undefined;
  const errorMsg = typeof errorKey === "string" ? errors[errorKey] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif={copy.serif} heavy={copy.heavy} />
        {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}
        {doneMsg ? <Notice>{doneMsg}</Notice> : null}
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
            {leaveOptionsLine({
              canManageBilling: Boolean(workspace.stripeCustomerId),
              hasGmail: mailboxes.length > 0,
            })}{" "}
            Questions? Call or text us at{" "}
            <a
              href={phoneHref("tel", siteConfig.phone)}
              className="font-semibold text-charcoal underline underline-offset-4"
            >
              {siteConfig.phone}
            </a>
            .
          </p>
          {/* Stripe's page needs a Stripe customer: none for a plan set by hand or reset. */}
          {workspace.stripeCustomerId ? (
            <div className="flex flex-col gap-2">
              <form action={openPortalFromTermsAction}>
                <Button type="submit" variant="outline" className="w-full">
                  Manage billing
                </Button>
              </form>
              <p className="text-sm text-muted-foreground">
                Cancel or change your plan on Stripe&apos;s secure page.
              </p>
            </div>
          ) : null}
          {mailboxes.length > 0 ? (
            <ul aria-label="Your Gmail" className="flex flex-col gap-3">
              {mailboxes.map((m) => (
                <li key={m.id} className="flex flex-col gap-2">
                  <span className="font-semibold break-all">{m.email}</span>
                  <DisconnectButton
                    mailboxId={m.id}
                    email={m.email}
                    action={disconnectMailboxFromTermsAction}
                  />
                </li>
              ))}
            </ul>
          ) : null}
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
          <DeleteAccountButton
            hasPlan={Boolean(workspace.stripeSubscriptionId)}
            action={deleteAccountFromTermsAction}
          />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
