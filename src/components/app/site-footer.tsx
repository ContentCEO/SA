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
      <span>{siteConfig.copyright}</span>
    </footer>
  );
}
