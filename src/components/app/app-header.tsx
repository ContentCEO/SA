import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";

export function AppHeader() {
  return (
    <header className="flex items-center justify-between">
      <Link href="/queue" className="inline-flex min-h-tap items-center rounded-md">
        <Wordmark />
      </Link>
      <nav aria-label="Main" className="flex items-center">
        {[
          ["/queue", "Queue"],
          ["/inbox", "Inbox"],
          ["/activity", "Activity"],
          ["/settings", "Settings"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href!}
            className="inline-flex min-h-tap items-center px-1.5 font-semibold last:pr-0"
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
