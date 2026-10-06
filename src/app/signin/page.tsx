import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Notice } from "@/components/app/notice";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { getWorkspaceForUser } from "@/server/accounts";

export const metadata: Metadata = { title: "Sign in · Squared Away" };

export default async function SignInPage(props: PageProps<"/signin">) {
  const session = await auth();
  // A session for an account that no longer exists (deleted on another device) stays here.
  if (session?.user?.id && (await getWorkspaceForUser(session.user.id))) redirect("/queue");
  const { error } = await props.searchParams;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-6">
      <header>
        <Link href="/" className="inline-flex min-h-tap items-center">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 py-12">
        <Headline serif="your inbox," heavy="handled." size="xl" />
        <p className="max-w-sm text-lg text-muted-foreground">
          Squared Away sorts your business email, drafts replies in your voice, and waits for your
          okay before anything goes out.
        </p>
        {error ? (
          <Notice strong>Sign-in didn&apos;t go through. Give it another try.</Notice>
        ) : null}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/queue" });
          }}
        >
          <Button type="submit" size="lg" className="w-full sm:w-auto">
            Sign in with Google
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">
          Not invited yet?{" "}
          <Link href="/#waitlist" className="font-semibold underline underline-offset-4">
            Join the waitlist
          </Link>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          Signing in only shares your name and email address. Connecting Gmail is a separate step,
          and we&apos;ll explain it first.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
