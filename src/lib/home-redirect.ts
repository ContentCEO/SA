/**
 * Check 29 P3: the homepage is prerendered and served from the CDN, so it can't ask Auth.js who
 * is visiting. The proxy (src/proxy.ts) sends a visitor who carries an Auth.js session cookie
 * from "/" to /start instead. It only looks for the cookie, never at what's in it: /start's
 * requireOwner does the real check, and /signin doesn't bounce a deleted account's stale cookie
 * back, so a bad cookie ends on /signin. Signing out clears the cookie, and "/" shows again.
 */
export const SIGNED_IN_HOME = "/start";

/** Auth.js v5's session cookie names (plain and on https); a large one is split into `.0`, `.1`. */
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function hasSessionCookie(cookieNames: readonly string[]): boolean {
  return cookieNames.some((n) => SESSION_COOKIE.test(n));
}

/** Where "/" sends this visitor, or null to show the homepage. Other paths: always null. */
export function homeRedirect(pathname: string, cookieNames: readonly string[]): string | null {
  return pathname === "/" && hasSessionCookie(cookieNames) ? SIGNED_IN_HOME : null;
}
