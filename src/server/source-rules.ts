/**
 * Where a waitlist / Growth sign-up came from: the utm_* tags of the link they landed on and the
 * referring site's host name — nothing else. Pure (no server-only, no db). Bad data is dropped,
 * never an error: these fields are filled in by the page, not the visitor.
 */
export type SignupSource = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string | null;
};

export const NO_SOURCE: SignupSource = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  referrerHost: null,
};

export const SOURCE_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "referrer_host"] as const;

const UTM_MAX = 100;

/** Trimmed, one line, no control characters or `<>"'\``, ≤ 100 characters; else null. */
export function cleanUtm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[<>"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return null;
  return v.length > UTM_MAX ? v.slice(0, UTM_MAX).trim() : v;
}

/** A host name (lowercased), never one of ours; else null. */
export function cleanHost(raw: unknown, ownHosts: readonly string[] = []): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!v || v.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return null;
  if (ownHosts.some((h) => h && h.toLowerCase() === v)) return null;
  return v;
}

/** Read the four hidden fields of a submitted form. */
export function sourceFromForm(
  get: (name: string) => unknown,
  ownHosts: readonly string[] = [],
): SignupSource {
  return {
    utmSource: cleanUtm(get("utm_source")),
    utmMedium: cleanUtm(get("utm_medium")),
    utmCampaign: cleanUtm(get("utm_campaign")),
    referrerHost: cleanHost(get("referrer_host"), ownHosts),
  };
}

export const hasSource = (s: Partial<SignupSource>) =>
  Boolean(s.utmSource || s.utmMedium || s.utmCampaign || s.referrerHost);

/** "facebook · post · fall-flyer (via facebook.com)" for the admin card, or null. */
export function describeSource(s: Partial<SignupSource>): string | null {
  if (!hasSource(s)) return null;
  const tags = [s.utmSource, s.utmMedium, s.utmCampaign].filter(Boolean).join(" · ");
  const via = s.referrerHost ? `via ${s.referrerHost}` : "";
  if (tags && via) return `${tags} (${via})`;
  return tags || via;
}

/** First touch: an existing row takes a source only when it has none yet. */
export function firstTouch(existing: Partial<SignupSource>, incoming: SignupSource) {
  return hasSource(existing) ? {} : incoming;
}
