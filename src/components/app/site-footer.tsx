import Link from "next/link";
import { siteConfig } from "@/config/site";

export function SiteFooter() {
  const support = process.env.SUPPORT_EMAIL;
  return (
    <footer className="flex flex-col gap-1 text-sm text-muted-foreground">
      <span>
        Questions? Call {siteConfig.phone}
        {support ? (
          <>
            {" "}
            or email{" "}
            <a className="underline underline-offset-4" href={`mailto:${support}`}>
              {support}
            </a>
          </>
        ) : null}
        .
      </span>
      <nav aria-label="Legal" className="flex gap-4">
        <Link
          href="/privacy"
          className="inline-flex min-h-tap items-center underline underline-offset-4"
        >
          Privacy
        </Link>
        <Link
          href="/terms"
          className="inline-flex min-h-tap items-center underline underline-offset-4"
        >
          Terms
        </Link>
      </nav>
      <span>{siteConfig.copyright}</span>
    </footer>
  );
}
