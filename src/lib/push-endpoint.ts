/**
 * Plan #36: the push services we deliver to. Pure (no server or database imports), so both the
 * subscribe path (src/server/push-alerts.ts) and the sender (src/lib/web-push.ts) check it: a
 * stored row that somehow skipped the subscribe check still never makes the server fetch an
 * internal or arbitrary URL (M11 C6).
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}
