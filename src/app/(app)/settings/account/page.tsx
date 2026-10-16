import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { signOut } from "@/auth";
import { DeleteAccountButton } from "@/components/app/delete-account-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { cn } from "@/lib/utils";
import { requireOwner } from "@/server/session";
import { deleteAccountAction } from "../actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Account" };

export default async function AccountSettingsPage(props: PageProps<"/settings/account">) {
  const { workspace } = await requireOwner();
  return (
    <SettingsScreen
      path="/settings/account"
      heavy="your account."
      params={await props.searchParams}
    >
      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="sr-only">
          Account
        </h2>
        <Link href="/billing" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
          Plan &amp; billing
        </Link>
        <form
          action={async () => {
            "use server";
            // A phone that kept the queue (plan #10) stops keeping it.
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
          action={deleteAccountAction}
        />
      </section>
    </SettingsScreen>
  );
}
