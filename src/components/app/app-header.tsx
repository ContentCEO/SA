import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";

export function AppHeader() {
  return (
    <header className="flex items-center justify-between">
      <Link href="/inbox" className="inline-flex min-h-tap items-center rounded-md">
        <Wordmark />
      </Link>
      <nav aria-label="Main" className="flex items-center">
        <Link href="/inbox" className="inline-flex min-h-tap items-center px-3 font-semibold">
          Inbox
        </Link>
        <Link href="/settings" className="inline-flex min-h-tap items-center pl-3 font-semibold">
          Settings
        </Link>
      </nav>
    </header>
  );
}
