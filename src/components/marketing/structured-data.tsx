import { appUrl } from "@/lib/app-url";
import { jsonLd, structuredData } from "@/lib/structured-data";

/** The homepage's structured data for search engines (src/lib/structured-data.ts). */
export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: jsonLd(structuredData(appUrl("/"), { supportEmail: process.env.SUPPORT_EMAIL })),
      }}
    />
  );
}
