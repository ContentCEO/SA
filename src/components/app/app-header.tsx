import Link from "next/link";
import { signOut } from "@/auth";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";

export function AppHeader() {
  return (
    <header className="flex items-center justify-between">
      <Link href="/settings" className="inline-flex min-h-tap items-center rounded-md">
        <Wordmark />
      </Link>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <Button type="submit" variant="ghost" size="sm">
          Sign out
        </Button>
      </form>
    </header>
  );
}
