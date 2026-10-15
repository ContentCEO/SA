/**
 * The "I agree" boxes (Davi, 2026-10-15). Massachusetts' top court enforces online terms only
 * with clear notice and clear assent (Kauders v. Uber, 2021); a tick box next to a button, with
 * the terms linked, was enough in Good v. Uber (2024). So the terms are agreed to with a box at
 * sign-in (trial owners never see Stripe), again on /welcome/terms whenever this version moves
 * on, and with Stripe's own box at checkout.
 *
 * Pure: no `server-only`, no database (the proxy and the tests read it too).
 */

/**
 * The version of the terms people agree to: the "Last updated" date of docs/terms.md (and of
 * docs/privacy-policy.md, which carries the same date), as YYYY-MM-DD. Change it with the
 * documents: everyone is then asked to agree again on their next screen. A unit test keeps the
 * three in step.
 */
export const TERMS_VERSION = "2026-10-15";

/**
 * Set by the sign-in button's server action when the box is ticked, read (and deleted) when
 * Google sends the person back, so the acceptance is recorded on their account. Short-lived,
 * httpOnly, SameSite=Lax, and only sent to Auth.js's own routes.
 */
export const TERMS_COOKIE = "sa_terms_agreed";
export const TERMS_COOKIE_PATH = "/api/auth";
export const TERMS_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** The checkbox's name and value in both forms (sign-in and /welcome/terms). */
export const AGREE_FIELD = "agree";
export const AGREE_VALUE = "yes";

/** Said when the button is pressed without the box ticked. */
export const AGREE_REQUIRED_MESSAGE =
  "Tick the box to agree to the Terms of Service and the Privacy Policy first.";

/** The 403 an API route answers for someone who hasn't agreed to the current terms. */
export const TERMS_REQUIRED_API_MESSAGE = "Agree to the updated Terms of Service in the app first.";

/**
 * The request header the proxy (src/proxy.ts) sets on every signed-in screen: the path and query
 * the person asked for, so the terms screen can send them back there afterwards. The proxy always
 * overwrites it; it is only ever used as a same-origin relative path (`safeNextPath`).
 */
export const REQUEST_PATH_HEADER = "x-sa-request-path";

/** Where everyone goes when there's nowhere better to send them. */
export const DEFAULT_NEXT_PATH = "/queue";
