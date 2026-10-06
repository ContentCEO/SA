import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

export async function register() {
  if (sentryOptions.enabled) Sentry.init(sentryOptions);
}

/** Server errors in pages, actions and routes → Sentry (scrubbed; no-op without a DSN). */
export const onRequestError = Sentry.captureRequestError;
