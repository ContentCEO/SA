import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
import { SMOKE_SPECS } from "./tests/e2e/smoke-specs";

config({ path: [".env.local", ".env"], quiet: true });

const port = Number(process.env.PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
/**
 * PLAYWRIGHT_BASE_URL = a smoke run against a deployed site: no servers, no fakes, no hooks, no
 * database (the global setup returns at once), and only the specs in SMOKE_SPECS, which touch
 * no database.
 */
const startServers = !process.env.PLAYWRIGHT_BASE_URL;

/**
 * Local end-to-end mode (src/config/e2e.ts): the app talks to fake Google / Gmail / Anthropic
 * (tests/e2e/fakes) on the next port, 127.0.0.1 only, and /api/test-hooks/run runs the job
 * steps without Inngest. Workers inherit this process's env, so `??=` gives every worker the
 * same hook secret.
 */
const fakesPort = Number(process.env.E2E_FAKES_PORT ?? port + 1);
const fakesUrl = `http://127.0.0.1:${fakesPort}`;
process.env.E2E_FAKES_URL = fakesUrl;
process.env.SA_E2E_HOOK_SECRET ??= randomBytes(32).toString("hex");

if (startServers) {
  // The OAuth redirect, the callback's redirects and the cookies all use APP_URL: a different
  // origin from the one the browser drives looks like an "expired" connect, so stop here.
  const appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : "(unset)";
  if (appOrigin !== new URL(baseURL).origin) {
    throw new Error(
      `APP_URL (${appOrigin}) must be the origin Playwright drives (${new URL(baseURL).origin}). ` +
        "Set APP_URL and PORT to match in .env.local.",
    );
  }
}

export default defineConfig({
  testDir: "./tests/e2e",
  ...(startServers ? {} : { testMatch: SMOKE_SPECS.map((name) => `**/${name}`) }),
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Check 31 P8: in CI, also a JSON file, so the job summary can list tests that passed only on
  // their retry (scripts/flaky-report.mjs).
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "playwright-results.json" }]]
    : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    // Check 45 P1: signed-in pages save the browser's zone while it was never set; a fixed zone
    // keeps that the same as the old default (Eastern) wherever a spec doesn't pick its own.
    timezoneId: "America/New_York",
    // Lets sandboxes with a preinstalled Chromium skip `playwright install`.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  // Mobile first: the primary target is a 375px-wide phone.
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
      },
    },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: startServers
    ? [
        {
          command: "pnpm exec tsx tests/e2e/fakes/main.ts",
          url: `${fakesUrl}/__health`,
          env: { E2E_FAKES_PORT: String(fakesPort) },
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
        {
          // Loopback only: without --hostname, `next start` listens on every interface, and
          // the hook route can't tell where a request came from (request.url is built from
          // this listen hostname). `localhost` keeps request.url, APP_URL and the cookies on
          // the same origin as before.
          command: `pnpm start --port ${port} --hostname localhost`,
          url: `${baseURL}/api/health`,
          // Neutral values only: nothing real (the Google client secret, an Anthropic key, an
          // Inngest key that would wake the production app) is ever handed to the fakes or sent
          // anywhere. An empty INNGEST_EVENT_KEY makes enqueue() fail, which it swallows. The
          // fakes refuse any other Google client or Anthropic key (tests/e2e/fakes/server.ts).
          env: {
            SA_E2E: "1",
            SA_E2E_GOOGLE_BASE_URL: `${fakesUrl}/google`,
            SA_E2E_ANTHROPIC_BASE_URL: `${fakesUrl}/anthropic`,
            SA_E2E_HOOK_SECRET: process.env.SA_E2E_HOOK_SECRET,
            AUTH_GOOGLE_ID: "e2e-client-id",
            AUTH_GOOGLE_SECRET: "e2e-client-secret",
            ANTHROPIC_API_KEY: "e2e-fake-key",
            INNGEST_EVENT_KEY: "",
            // Playwright passes the rest of this process's env (all of .env.local) to the app:
            // blank every other real service so a run can't email, charge, text or push
            // anyone. The specs expect these off (billing.spec.ts: no Stripe key). The Sentry
            // DSN (NEXT_PUBLIC_*) is fixed at `pnpm build`, so blanking it here only covers
            // what reads it at runtime; build e2e without it set.
            ...Object.fromEntries(
              [
                "RESEND_API_KEY",
                "EMAIL_FROM",
                "STRIPE_SECRET_KEY",
                "STRIPE_WEBHOOK_SECRET",
                "TWILIO_ACCOUNT_SID",
                "TWILIO_AUTH_TOKEN",
                "TWILIO_MESSAGING_SERVICE_SID",
                "TWILIO_FROM_NUMBER",
                "VAPID_PUBLIC_KEY",
                "VAPID_PRIVATE_KEY",
                "GMAIL_PUBSUB_TOPIC",
                "GMAIL_PUSH_VERIFICATION_TOKEN",
                "INNGEST_SIGNING_KEY",
                "NEXT_PUBLIC_SENTRY_DSN",
              ].map((name) => [name, ""]),
            ),
          },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : undefined,
});
