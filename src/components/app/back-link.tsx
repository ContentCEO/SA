import { ChevronLeft } from "lucide-react";
import Link from "next/link";

/** "< Settings" — the way back at the top of a screen (44px tall, Check 15 P3). */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="-ml-1 inline-flex min-h-tap items-center gap-1 self-start font-semibold underline-offset-4 hover:underline"
    >
      <ChevronLeft aria-hidden className="size-5" />
      {children}
    </Link>
  );
}

/** "Cancel" under a form's main button: back without saving (Check 15 P3). */
export function CancelLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-tap items-center justify-center self-center px-4 font-semibold underline underline-offset-4"
    >
      Cancel
    </Link>
  );
}
