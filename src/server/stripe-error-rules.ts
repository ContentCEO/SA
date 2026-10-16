/**
 * Why "Connect Stripe" failed, as a fixed code and a plain sentence (M11 C10). Pure.
 *
 * Stripe's own error messages can echo ids and request details, and the old admin page put
 * them in the URL and showed whatever `?reason=` held — so a crafted link could make Davi's
 * admin page say anything "Stripe said". Now only a code from this list travels, and the page
 * shows our sentence for it.
 */
export const STRIPE_REASONS = {
  auth: "Stripe didn't accept the secret key. Check STRIPE_SECRET_KEY in Vercel, then redeploy.",
  permission:
    "The Stripe key is missing a permission this needs. Use the standard secret key, not a restricted one.",
  connection: "We couldn't reach Stripe. Try again in a minute.",
  rate_limit: "Stripe asked us to slow down. Try again in a minute.",
  invalid_request:
    "Stripe refused one of the setup steps. Its dashboard has the details under Developers → Logs.",
  api: "Stripe had a problem on its side. Try again in a few minutes.",
  unknown:
    "Something other than Stripe's answer went wrong. Check that STRIPE_SECRET_KEY, TOKEN_ENCRYPTION_KEY and DATABASE_URL are set in Vercel, then try again.",
} as const;

export type StripeReason = keyof typeof STRIPE_REASONS;

/** Stripe's error classes (`err.type` on errors from the stripe package) → our codes. */
const BY_TYPE: Record<string, StripeReason> = {
  StripeAuthenticationError: "auth",
  StripePermissionError: "permission",
  StripeConnectionError: "connection",
  StripeRateLimitError: "rate_limit",
  StripeInvalidRequestError: "invalid_request",
  StripeIdempotencyError: "invalid_request",
  StripeAPIError: "api",
};

/** Never returns any text from the error itself — only one of the fixed codes. */
export function stripeErrorReason(err: unknown): StripeReason {
  if (!err || typeof err !== "object") return "unknown";
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(BY_TYPE, type) ? BY_TYPE[type]! : "unknown";
}

/**
 * Stripe's refusal of the checkout "I agree" box (`consent_collection.terms_of_service`) because
 * no Terms of Service URL is saved in its dashboard (Settings → Business → Public details). Its
 * docs say the URL must be set first but don't print the error; it is an invalid-request error,
 * so this matches one that names the consent parameter, or that talks about the terms of service
 * and a URL. Read only to decide; the text itself is never logged or shown. Not checked live (no
 * Stripe key in the sandbox): the first checkout without the URL shows which part matched.
 */
export function isTermsUrlMissingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { type, param, message } = err as { type?: unknown; param?: unknown; message?: unknown };
  if (type !== "StripeInvalidRequestError") return false;
  if (typeof param === "string" && param.startsWith("consent_collection")) return true;
  return (
    typeof message === "string" &&
    /terms of service/i.test(message) &&
    /\b(url|public details|settings\/public)\b/i.test(message)
  );
}

/** The sentence for a `?reason=` value; anything not on the list shows nothing. */
export function stripeReasonText(reason: unknown): string | null {
  return typeof reason === "string" && Object.hasOwn(STRIPE_REASONS, reason)
    ? STRIPE_REASONS[reason as StripeReason]
    : null;
}
