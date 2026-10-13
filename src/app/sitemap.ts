import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

/** The public pages, on whatever domain APP_URL says (never hardcoded). */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: appUrl("/"), changeFrequency: "weekly", priority: 1 },
    { url: appUrl("/growth"), changeFrequency: "monthly", priority: 0.8 },
    { url: appUrl("/privacy"), changeFrequency: "monthly", priority: 0.3 },
    { url: appUrl("/terms"), changeFrequency: "monthly", priority: 0.3 },
  ];
}
