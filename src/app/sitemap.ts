import type { MetadataRoute } from "next";
import { TERMS_VERSION } from "@/config/legal";
import { CONTENT_DATES } from "@/config/site";
import { appUrl } from "@/lib/app-url";

/** The date part of TERMS_VERSION ("YYYY-MM-DD", or "YYYY-MM-DD.N" after a same-day release). */
export const legalDate = (version: string = TERMS_VERSION) => version.slice(0, 10);

/**
 * The public pages, on whatever domain APP_URL says (never hardcoded). Check 33 P4: each with the
 * day its words last changed (CONTENT_DATES; the legal pages share the terms' date).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const legal = legalDate();
  return [
    { url: appUrl("/"), lastModified: CONTENT_DATES.home, changeFrequency: "weekly", priority: 1 },
    {
      url: appUrl("/growth"),
      lastModified: CONTENT_DATES.growth,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    { url: appUrl("/privacy"), lastModified: legal, changeFrequency: "monthly", priority: 0.3 },
    { url: appUrl("/terms"), lastModified: legal, changeFrequency: "monthly", priority: 0.3 },
  ];
}
