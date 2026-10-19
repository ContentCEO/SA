import { siteConfig } from "@/config/site";

/**
 * Check 28 P3 (and Check 1 P7): where Squared Away's Google app is in Google's process, so the
 * screens say what Google's own screen will show. One server env, `GOOGLE_APP_STATE`
 * (Production only; docs/SETUP.md §4, docs/LAUNCH.md 0c). Never add a second env for this fact.
 *
 * - `testing` (default, today): the app's publishing status is Testing. A test user sees Google's
 *   "hasn't verified this app" screen with a **Continue** button, and Google ends its Gmail access
 *   after 7 days.
 * - `unverified`: published (In production) but not yet verified. The link sits under
 *   **Advanced** and Google adds "(unsafe)" to it; until the branding is published Google shows
 *   the domain rather than the app name.
 * - `verified`: Google approved the app. No warning at all.
 *
 * Unknown or missing values fall back to `testing`. Pure (no `server-only`, no database) so the
 * tests and the pure email builders can use it. Davi sets it to "unverified" when publishing and
 * "verified" when Google approves, then redeploys.
 *
 * Integrator (wave 3 merge A): the App emails and Google groups each wrote this file; this is the
 * one copy, with both groups' names (`googleAppStateFrom` is `parseGoogleAppState`).
 */

export const GOOGLE_APP_STATES = ["testing", "unverified", "verified"] as const;
export type GoogleAppState = (typeof GOOGLE_APP_STATES)[number];

export function parseGoogleAppState(value: string | undefined): GoogleAppState {
  const v = value?.trim().toLowerCase();
  return (GOOGLE_APP_STATES as readonly string[]).includes(v ?? "")
    ? (v as GoogleAppState)
    : "testing";
}

/** The App emails group's name for `parseGoogleAppState`. */
export const googleAppStateFrom = parseGoogleAppState;

/** The state from the environment (read at request time, so a redeploy after a change is enough). */
export function googleAppState(
  env: Record<string, string | undefined> = process.env,
): GoogleAppState {
  return parseGoogleAppState(env.GOOGLE_APP_STATE);
}

/**
 * The connect screen's line about Google's warning, in plain words with no dashes, or null when
 * there is nothing to warn about (verified).
 */
export function googleWarningLine(
  state: GoogleAppState,
  brandName: string = siteConfig.name,
): string | null {
  switch (state) {
    case "testing":
      return `Google will show a screen saying it hasn't verified ${brandName} yet. That's expected while we're in early access. Tap Continue.`;
    case "unverified":
      return "Google will say it hasn't verified the app yet. That's expected until its check is done. Tap Advanced, then the link that starts with Go to. Google adds the word unsafe to every app it hasn't finished checking.";
    case "verified":
      return null;
  }
}

/**
 * Check 1 P7: why Google access stopped, for the access-lost email and Settings → Your Gmail.
 * In Testing, Google ends access every 7 days, so "a password change" would be the wrong reason
 * for every owner in their first week.
 */
export const ACCESS_LOST_REASON_TESTING = `While ${siteConfig.name} waits for Google's approval, Google ends access every 7 days. Reconnecting takes a minute and nothing is lost.`;
export const ACCESS_LOST_REASON_DEFAULT =
  "Google sometimes ends access on its own, for example after a password change.";

export function accessLostReason(state: GoogleAppState): string {
  return state === "testing" ? ACCESS_LOST_REASON_TESTING : ACCESS_LOST_REASON_DEFAULT;
}
