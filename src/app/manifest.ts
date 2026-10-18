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
    lang: "en-US",
    dir: "ltr",
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Check 46 P4: Chrome on Android shows these in its richer install sheet. Made from the
    // invented e2e seed data only (scripts/app-shots.mjs), never a real mailbox.
    screenshots: [
      {
        src: "/app-shots/queue.png",
        sizes: "1080x1920",
        type: "image/png",
        form_factor: "narrow",
        label: "Replies waiting for your okay",
      },
      {
        src: "/app-shots/draft.png",
        sizes: "1080x1920",
        type: "image/png",
        form_factor: "narrow",
        label: "A reply you can change before it goes",
      },
      {
        src: "/app-shots/quotes.png",
        sizes: "1080x1920",
        type: "image/png",
        form_factor: "narrow",
        label: "Every quote request, waiting or won",
      },
    ],
  };
}
