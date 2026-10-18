/**
 * Per-device cookie names (plan #9 left hand, #37 sunlight, #10 offline queue). No
 * "server-only": the Sunlight button writes its cookie from the page (Check 8 P4).
 */
export const HAND_COOKIE = "sa_hand";
export const CONTRAST_COOKIE = "sa_contrast";
export const OFFLINE_COOKIE = "sa_offline";
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // the browser maximum

/**
 * The Sunlight cookie as `document.cookie` takes it: a display setting with nothing secret in
 * it, so it isn't httpOnly. Switching off expires it.
 */
export function contrastCookie(on: boolean, https: boolean): string {
  const parts = [
    `${CONTRAST_COOKIE}=${on ? "high" : ""}`,
    "path=/",
    `max-age=${on ? DEVICE_COOKIE_MAX_AGE : 0}`,
    "SameSite=Lax",
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}
