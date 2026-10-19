import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

/**
 * Search engines may read the public pages only — never the app or the API. /admin isn't
 * named (Check 26 P9: a robots.txt line would announce the page requireAdmin hides behind a
 * 404); its pages carry `robots: { index: false }` instead. Check 33 P4: /signin, /not-invited
 * and /goodbye aren't blocked either; they carry a noindex tag, which a crawler can only see if
 * it may read the page (a blocked page can still show up in results by its address).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/growth", "/privacy", "/terms"],
      disallow: [
        "/api/",
        "/queue",
        "/inbox",
        "/quotes",
        "/money",
        "/more",
        "/record",
        "/customers",
        "/activity",
        "/settings",
        "/billing",
        "/connect",
        "/welcome",
        "/start",
        "/my-growth",
      ],
    },
    sitemap: appUrl("/sitemap.xml"),
  };
}
