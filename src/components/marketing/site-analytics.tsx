import { SiteAnalyticsClient } from "./site-analytics-client";

/**
 * Vercel Web Analytics page views, on the public pages only (homepage, /growth, /privacy,
 * /terms) — never mounted in the root layout or the signed-in app, so those screens never load
 * the script. Production only: the script and its reports stay on our own origin
 * (/_vercel/insights), so the CSP needs no change, and it sets no cookies. Previews sit behind
 * Vercel login and dev mode would load a script from another host. Counting starts once Davi
 * switches Analytics on in Vercel.
 */
export function SiteAnalytics() {
  if (process.env.VERCEL_ENV !== "production") return null;
  return <SiteAnalyticsClient />;
}
