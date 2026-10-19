import type { Metadata } from "next";
import { ForgetOffline } from "@/components/app/forget-offline";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Notice } from "@/components/app/notice";
import { SiteFooter } from "@/components/app/site-footer";
import { TermsForm } from "@/components/app/terms-form";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { getWorkspaceForSession } from "@/server/accounts";
import { safeNextPath } from "@/server/terms-rules";
import { signInWithGoogleAction } from "./actions";
import { SkipLink } from "@/components/app/skip-link";

// Check 33 P4: linked from the homepage, so search engines may read it and find the noindex here
// (robots.txt no longer blocks it: a blocked page can still be listed by its address).
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: true } };

export default async function SignInPage(props: PageProps<"/signin">) {
  const session = await auth();
  // A session for an account that no longer exists (deleted on another device) stays here.
  const { error, done, next, reason } = await props.searchParams;
  // Check 26 P4: asked to sign in again before deleting the account — signed in or not.
  const recent = reason === "recent";
  // Check 26 P3: so does one signed out everywhere (its version is behind), or it would loop.
  if (!recent && (await getWorkspaceForSession(session?.user))) redirect("/start");
  // Back to the screen that asked, after Google (a path on this site only: safeNextPath).
  const back = recent && typeof next === "string" ? safeNextPath(next) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <ForgetOffline />
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
        <Headline serif="your inbox," heavy="handled." size="xl" />
        <p className="max-w-sm text-lg text-muted-foreground">
          Squared Away sorts your business email, drafts replies in your voice, and waits for your
          okay before anything goes out.
        </p>
        {done === "everywhere" ? <Notice>Signed out everywhere.</Notice> : null}
        {recent ? (
          <Notice strong>For your safety, sign in again to delete your account.</Notice>
        ) : null}
        {error ? (
          <Notice strong>Sign-in didn&apos;t go through. Give it another try.</Notice>
        ) : null}
        <TermsForm
          action={signInWithGoogleAction}
          submitLabel="Sign in with Google"
          pendingLabel="Opening Google…"
          next={back}
        />
        <p className="text-sm text-muted-foreground">
          Not invited yet?{" "}
          <Link href="/#waitlist" className="font-semibold underline underline-offset-4">
            Join the waitlist
          </Link>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          From your Google sign-in we keep only your name and email address. Connecting Gmail is a
          separate step, and we&apos;ll explain it first.
        </p>
      </main>
      <SiteFooter growthLink />
    </div>
  );
}
