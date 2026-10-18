import Link from "next/link";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";

/** `growthLink`: public pages only (not the signed-in app). */
export function SiteFooter({ growthLink = false }: { growthLink?: boolean } = {}) {
  const support = process.env.SUPPORT_EMAIL;
  return (
    // gap-2: 8px between the phone link, the email and the legal links (gloves; Check 8 P8).
    <footer className="flex flex-col gap-2 text-sm text-muted-foreground">
      <span>
        Questions? Call{" "}
        <a
          href={phoneHref("tel", siteConfig.phone)}
          className="inline-flex min-h-tap items-center underline underline-offset-4"
        >
          {siteConfig.phone}
        </a>
        {support ? " or email" : "."}
      </span>
      {/* Check 8 P8 / Check 3 P8: its own line and a 44px target, like the phone link (it was
          17px tall, 1px under the phone link). break-all: a long address wraps, never scrolls. */}
      {support ? (
        <span>
          <a
            className="inline-flex min-h-tap items-center break-all underline underline-offset-4"
            href={`mailto:${support}`}
          >
            {support}
          </a>
          .
        </span>
      ) : null}
      <nav aria-label="Legal" className="flex gap-4">
        <Link
          href="/privacy"
          className="inline-flex min-h-tap min-w-tap items-center justify-center underline underline-offset-4"
        >
          Privacy
        </Link>
        <Link
          href="/terms"
          className="inline-flex min-h-tap min-w-tap items-center justify-center underline underline-offset-4"
        >
          Terms
        </Link>
      </nav>
      {growthLink ? (
        <Link
          href="/growth"
          className="inline-flex min-h-tap items-center self-start underline underline-offset-4"
        >
          Squared Away Growth
        </Link>
      ) : null}
      <span>{siteConfig.copyright}</span>
    </footer>
  );
}
