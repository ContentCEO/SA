import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";

export function AppHeader() {
  return (
    <header className="flex items-center justify-between">
      <Link href="/queue" className="inline-flex min-h-tap items-center rounded-md">
        <Wordmark />
      </Link>
      <nav aria-label="Main" className="flex items-center">
        <Link href="/queue" className="inline-flex min-h-tap items-center px-2 font-semibold">
          Queue
        </Link>
        <Link href="/inbox" className="inline-flex min-h-tap items-center px-2 font-semibold">
          Inbox
        </Link>
        <Link href="/settings" className="inline-flex min-h-tap items-center pl-2 font-semibold">
          Settings
        </Link>
      </nav>
    </header>
  );
}
