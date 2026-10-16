/**
 * Vercel Web Analytics on the public pages only: page views, no custom events, no cookies. Pure,
 * so it is unit-tested on its own. `beforeSend` is the second guard after "mounted on public
 * pages only": anything else is dropped, and an address keeps only its path and utm_* tags (so a
 * ?ref= code or anything else in a link never leaves).
 */
export const COUNTED_PATHS = ["/", "/growth", "/privacy", "/terms"] as const;

const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

/** The address to count, or null to drop the view. */
export function countedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!(COUNTED_PATHS as readonly string[]).includes(path)) return null;
  const kept = new URLSearchParams();
  for (const k of UTM) {
    const v = url.searchParams.get(k);
    if (v) kept.set(k, v.slice(0, 100));
  }
  const q = kept.toString();
  return `${url.origin}${path}${q ? `?${q}` : ""}`;
}

export type AnalyticsEvent = { type: "pageview" | "event"; url: string };

/** Page views of public pages only; custom events never. */
export function beforeSend<E extends AnalyticsEvent>(event: E): E | null {
  if (event.type !== "pageview") return null;
  const url = countedUrl(event.url);
  return url ? { ...event, url } : null;
}
