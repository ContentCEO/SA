/**
 * Where a visitor came from, first touch per tab: the utm_* tags of the page they landed on and
 * the referring site's host name (never the full referring URL, never our own host). Kept in
 * sessionStorage so it survives moving from / to /growth; the page works without it. The server
 * re-checks and length-caps everything (src/server/source-rules.ts).
 */
export type LandingSource = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referrer_host: string;
};

export const EMPTY_LANDING_SOURCE: LandingSource = {
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  referrer_host: "",
};

const KEY = "sa_source";
const MAX = 200;

const any = (s: LandingSource) => Object.values(s).some(Boolean);

/** Pure: read the tags from a query string and the host from a referrer URL. */
export function landingSourceFrom(
  search: string,
  referrer: string,
  ownHost: string,
): LandingSource {
  const q = new URLSearchParams(search);
  const tag = (k: string) => (q.get(k) ?? "").trim().slice(0, MAX);
  let referrerHost = "";
  try {
    const host = referrer ? new URL(referrer).hostname.toLowerCase() : "";
    if (host && host !== ownHost.toLowerCase()) referrerHost = host;
  } catch {
    // Not a URL: no referrer.
  }
  return {
    utm_source: tag("utm_source"),
    utm_medium: tag("utm_medium"),
    utm_campaign: tag("utm_campaign"),
    referrer_host: referrerHost,
  };
}

function stored(): LandingSource | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const s = (k: keyof LandingSource) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return {
      utm_source: s("utm_source"),
      utm_medium: s("utm_medium"),
      utm_campaign: s("utm_campaign"),
      referrer_host: s("referrer_host"),
    };
  } catch {
    return null;
  }
}

/** The first source this tab saw (stored once), or this page's own. Browser only. */
export function captureLandingSource(): LandingSource {
  if (typeof window === "undefined") return EMPTY_LANDING_SOURCE;
  const first = stored();
  if (first && any(first)) return first;
  const now = landingSourceFrom(
    window.location.search,
    document.referrer,
    window.location.hostname,
  );
  if (any(now)) {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(now));
    } catch {
      // Private window or blocked storage: this page's source still goes with the form.
    }
  }
  return now;
}
