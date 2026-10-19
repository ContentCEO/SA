import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { siteConfig } from "@/config/site";
import { Markdown } from "@/lib/markdown";
import { phoneHref } from "@/lib/phone-href";
import { SiteAnalytics } from "./site-analytics";
import { SourceCapture } from "./source-fields";
import { SkipLink } from "@/components/app/skip-link";

/**
 * /privacy and /terms are rendered from docs/privacy-policy.md and
 * docs/terms.md, so the documents in the repo are the single source. Contact
 * details come from src/config/site.ts and SUPPORT_EMAIL, never typed into
 * the documents.
 *
 * Check 27 P2: a data request needs a written way in. With SUPPORT_EMAIL set, the Contact block
 * ends with the email; without it, with a text link to the business phone (texts get a written
 * reply), so the block never offers a phone call alone.
 */
export async function loadLegalDoc(file: "privacy-policy.md" | "terms.md"): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), "docs", file), "utf8");
  return raw
    .replaceAll("{{OPERATOR}}", siteConfig.operator)
    .replaceAll("{{LOCATION}}", siteConfig.location)
    .replaceAll("{{PHONE}}", `[${siteConfig.phone}](tel:${siteConfig.phone})`)
    .replace(
      /\\\n\{\{SUPPORT_EMAIL_LINE\}\}/,
      `\\\n${writtenContactLine(process.env.SUPPORT_EMAIL)}`,
    );
}

/** The Contact block's written channel: "Email: …" when the support address is set, else "Text: …". */
export function writtenContactLine(supportEmail: string | undefined): string {
  const support = supportEmail?.trim();
  if (support) return `Email: [${support}](mailto:${support})`;
  return `Text: [${siteConfig.phone}](${phoneHref("sms", siteConfig.phone)}) (texts get a written reply)`;
}

/**
 * Check 7 P8: the legal pages open with the signature headline like every other screen, so the
 * document's own "# Privacy Policy" line is skipped (the .md files keep it for anyone reading
 * them in the repo).
 */
export function LegalPage({
  source,
  serif,
  heavy,
}: {
  source: string;
  serif: string;
  heavy: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-6">
      <SkipLink />
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex min-h-tap items-center"
          aria-label="Squared Away home"
        >
          <Wordmark />
        </Link>
        <Link href="/" className="inline-flex min-h-tap items-center px-2 font-semibold">
          Home
        </Link>
      </header>
      <main id="main" tabIndex={-1} className="flex flex-col gap-6 outline-none">
        <Headline serif={serif} heavy={heavy} />
        <Markdown source={source} skipFirstH1 />
      </main>
      <SiteFooter growthLink />
      <SourceCapture />
      <SiteAnalytics />
    </div>
  );
}
