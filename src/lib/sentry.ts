import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Error alerts. Off unless NEXT_PUBLIC_SENTRY_DSN is set (the DSN is public by
 * design — it only lets you *send* errors). Errors only: no performance
 * tracing, no session replay, no default PII.
 *
 * The rule from CLAUDE.md applies here too: no tokens, email bodies or
 * customer details ever leave for Sentry. So every event is scrubbed:
 * request bodies, cookies, headers and query strings are dropped, the user is
 * reduced to an id, and anything shaped like an email address is masked.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const mask = (s: string | undefined) => s?.replace(EMAIL, "[email]");

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split("?")[0];
  }
  event.user = event.user?.id ? { id: String(event.user.id) } : undefined;
  event.message = mask(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = mask(ex.value);
  event.breadcrumbs = (event.breadcrumbs ?? [])
    .filter((b) => b.category !== "console")
    .map((b) => ({ ...b, message: mask(b.message), data: undefined }));
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
