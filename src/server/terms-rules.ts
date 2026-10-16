/**
 * The "I agree" rules (Davi, 2026-10-15). Pure: no `server-only`, no database.
 */
import { AGREE_VALUE, DEFAULT_NEXT_PATH, TERMS_VERSION } from "@/config/legal";

/** What the two "I agree" forms get back from their actions: nothing, or the plain error. */
export type AgreeState = { error?: string };

/** A terms version: the documents' "Last updated" date, YYYY-MM-DD, so later sorts later. */
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether this person has agreed to the terms as they are now, or to a newer version. Newer
 * counts: previews share the production database, and a rollback runs older code, so someone
 * who agreed to terms dated after this deployment's has agreed to more, not less. Asking them
 * again here would show "we've updated our terms" when nothing changed for this deployment.
 */
export function hasCurrentTerms(
  user: { termsVersion: string | null } | null | undefined,
  version: string = TERMS_VERSION,
): boolean {
  const agreedTo = user?.termsVersion;
  return !!agreedTo && VERSION_SHAPE.test(agreedTo) && agreedTo >= version;
}

/** Whether the form's box was ticked: exactly our value, nothing else (a missing box sends none). */
export function agreed(value: FormDataEntryValue | null | undefined): boolean {
  return value === AGREE_VALUE;
}

/** The value the sign-in cookie carries counts only when it names the current version. */
export function cookieAgreesToCurrent(value: string | null | undefined): boolean {
  return value === TERMS_VERSION;
}

const ORIGIN = "https://squared-away.invalid";

/**
 * Where to send someone after they agree: a path on this site only, never another site.
 * Accepts "/queue", "/queue?t=…", "/settings/profile"; anything else (another site, "//host",
 * "/\\host", a scheme, whitespace or control characters, the terms screen itself, an API route,
 * something too long) → /queue. The #hash is dropped (browsers never send it anyway).
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return DEFAULT_NEXT_PATH;
  // Our own paths only: one leading "/", then not another "/" or "\" (protocol-relative).
  if (!/^\/(?![/\\])/.test(raw)) return DEFAULT_NEXT_PATH;
  // No backslashes (browsers read them as "/"), whitespace or control characters anywhere.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT_PATH;
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== ORIGIN) return DEFAULT_NEXT_PATH;
  const path = url.pathname;
  if (path === "/welcome/terms" || path.startsWith("/welcome/terms/")) return DEFAULT_NEXT_PATH;
  if (path === "/api" || path.startsWith("/api/")) return DEFAULT_NEXT_PATH;
  // Re-check what we built (the URL parser normalizes "/./x" and "/a/../b").
  const out = `${path}${url.search}`;
  return /^\/(?![/\\])/.test(out) ? out : DEFAULT_NEXT_PATH;
}

/** The path and query the proxy saw, minus Next's own `_rsc` marker. */
export function requestPathOf(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("_rsc");
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}

/**
 * The terms screen's wording: first time (never agreed) or after the terms changed. Plain words.
 */
export function termsScreenCopy(user: { termsVersion: string | null }) {
  return user.termsVersion === null
    ? {
        serif: "one thing first,",
        heavy: "the fine print.",
        lead:
          "Before you use Squared Away, please read our Terms of Service and Privacy Policy and " +
          "tick the box to agree to them.",
      }
    : {
        serif: "we've updated",
        heavy: "our terms.",
        lead:
          "We've changed our Terms of Service or Privacy Policy since you last agreed. Please " +
          "read them and tick the box to keep using Squared Away.",
      };
}

/**
 * Round 2 (FW): the way out on the terms screen names only what this person can do there: a
 * trial owner has no plan to cancel (no Manage billing button), and someone who never connected
 * Gmail has nothing to disconnect.
 */
export function leaveOptionsLine(o: { canManageBilling: boolean; hasGmail: boolean }): string {
  const choices = [
    o.canManageBilling ? "cancel your plan" : null,
    o.hasGmail ? "disconnect Gmail" : null,
    "delete your account",
  ].filter((c): c is string => c !== null);
  const list =
    choices.length === 1
      ? choices[0]!
      : `${choices.slice(0, -1).join(", ")} or ${choices[choices.length - 1]}`;
  return `You can still leave. ${list[0]!.toUpperCase()}${list.slice(1)} right here, or just sign out.`;
}
