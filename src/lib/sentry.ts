import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Error alerts. Off unless NEXT_PUBLIC_SENTRY_DSN is set (the DSN is public by
 * design — it only lets you *send* errors). Errors only: no performance
 * tracing, no session replay, no default PII.
 *
 * The rule from CLAUDE.md applies here too: no tokens, email bodies or
 * customer details ever leave for Sentry. So every event is scrubbed:
 * request bodies, cookies, headers and query strings are dropped, the user is
 * reduced to an id, anything shaped like an email address is masked, and a
 * failed query's bound values ("params: …") are dropped.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const mask = (s: string | undefined) => s?.replace(EMAIL, "[email]");

/**
 * A failed database query (Drizzle's DrizzleQueryError) reads
 * "Failed query: <sql>\nparams: <every bound value>" — the values are the row being written:
 * a remembered price and the kind of job, invoice facts, draft text. Drop everything from
 * "params:" on, wherever it shows up, and keep only the first line (the SQL, which has
 * placeholders, not values) of anything that starts "Failed query:".
 */
const QUERY_PARAMS = /\n\s*params:[\s\S]*$/;
function scrubText(s: string | undefined): string | undefined {
  if (s == null) return s;
  let out = s.replace(QUERY_PARAMS, "\nparams: [dropped]");
  if (out.startsWith("Failed query:")) out = out.split("\n")[0];
  return mask(out);
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split("?")[0];
  }
  event.user = event.user?.id ? { id: String(event.user.id) } : undefined;
  event.message = scrubText(event.message);
  if (event.logentry) event.logentry = { message: scrubText(event.logentry.message) };
  // Every value, including the linked `cause` errors Sentry lists alongside the main one.
  for (const ex of event.exception?.values ?? []) ex.value = scrubText(ex.value);
  // A click/input breadcrumb ("ui.click") describes the tapped element, aria-label and all —
  // which can carry an amount or a customer's name. Keep only that something was tapped.
  event.breadcrumbs = (event.breadcrumbs ?? [])
    .filter((b) => b.category !== "console")
    .map((b) => ({
      ...b,
      message: b.category?.startsWith("ui.") ? undefined : mask(b.message),
      data: undefined,
    }));
  delete event.extra;
  return event;
}

export const sentryOptions = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
};
