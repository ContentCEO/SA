import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

/** Search engines may read the public pages only — never the app, admin or API. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/growth", "/privacy", "/terms"],
      disallow: [
        "/admin",
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
        "/signin",
        "/not-invited",
        "/goodbye",
        "/start",
        "/my-growth",
      ],
    },
    sitemap: appUrl("/sitemap.xml"),
  };
}
