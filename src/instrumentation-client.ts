import { sentryOptions } from "@/lib/sentry";

// Loaded only when a DSN is set, so phones don't download the SDK for nothing.
if (sentryOptions.enabled) {
  void import("@sentry/nextjs").then((Sentry) =>
    Sentry.init({ ...sentryOptions, integrations: [] }),
  );
}
