import { siteConfig } from "@/config/site";

/**
 * Where the Google OAuth app stands (docs/LAUNCH.md step 0c): `testing` while only test users
 * can sign in (Google ends every owner's Gmail access after 7 days), `unverified` once published
 * but before Google's check is done, `verified` once approved. Read from `GOOGLE_APP_STATE`
 * (Production only; unset or unknown → `testing`, which is right today). One env drives both the
 * connect screen's warning (Check 28 P3) and the access-lost reason (Check 1 P7). Davi sets it to
 * "unverified" when publishing and "verified" when Google approves, then redeploys.
 */
export type GoogleAppState = "testing" | "unverified" | "verified";

export function googleAppStateFrom(value: string | undefined): GoogleAppState {
  const v = value?.trim().toLowerCase();
  return v === "unverified" || v === "verified" ? v : "testing";
}

export function googleAppState(): GoogleAppState {
  return googleAppStateFrom(process.env.GOOGLE_APP_STATE);
}

/** The connect screen's line about Google's consent warning, or null once verified (Check 28 P3). */
export function googleWarningLine(
  state: GoogleAppState,
  brandName = siteConfig.name,
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
