import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { SiteFooter } from "@/components/app/site-footer";
import { Wordmark } from "@/components/brand/wordmark";
import { siteConfig } from "@/config/site";
import { Markdown } from "@/lib/markdown";
import { SiteAnalytics } from "./site-analytics";
import { SourceCapture } from "./source-fields";

/**
 * /privacy and /terms are rendered from docs/privacy-policy.md and
 * docs/terms.md, so the documents in the repo are the single source. Contact
 * details come from src/config/site.ts and SUPPORT_EMAIL, never typed into
 * the documents.
 */
export async function loadLegalDoc(file: "privacy-policy.md" | "terms.md"): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), "docs", file), "utf8");
  const support = process.env.SUPPORT_EMAIL?.trim();
  return raw
    .replaceAll("{{OPERATOR}}", siteConfig.operator)
    .replaceAll("{{LOCATION}}", siteConfig.location)
    .replaceAll("{{PHONE}}", `[${siteConfig.phone}](tel:${siteConfig.phone})`)
    .replace(
      /\\\n\{\{SUPPORT_EMAIL_LINE\}\}/,
      support ? `\\\nEmail: [${support}](mailto:${support})` : "",
    );
}

export function LegalPage({ source }: { source: string }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-6">
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
      <main>
        <Markdown source={source} />
      </main>
      <SiteFooter growthLink />
      <SourceCapture />
      <SiteAnalytics />
    </div>
  );
}
