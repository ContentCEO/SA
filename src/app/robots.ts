import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

/** Search engines may read the public pages only — never the app, admin or API. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/privacy", "/terms"],
      disallow: [
        "/admin",
        "/api/",
        "/queue",
        "/inbox",
        "/quotes",
        "/customers",
        "/activity",
        "/settings",
        "/billing",
        "/connect",
        "/welcome",
        "/signin",
        "/not-invited",
        "/goodbye",
      ],
    },
    sitemap: appUrl("/sitemap.xml"),
  };
}
