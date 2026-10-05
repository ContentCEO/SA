import type { MetadataRoute } from "next";

/**
 * Makes the site installable as an app (Android "Install", iPhone "Add to
 * Home Screen"): same login, same data, opens full-screen on the queue.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Squared Away",
    short_name: "Squared Away",
    description: "Your inbox, handled.",
    id: "/queue",
    start_url: "/queue",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F7F6F3",
    theme_color: "#1B1B1B",
    categories: ["business", "productivity"],
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
