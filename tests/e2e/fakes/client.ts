/**
 * Spec-side helpers for the e2e fakes (tests/e2e/fakes/server.ts) and the test-hooks route
 * (/api/test-hooks/run). Playwright starts both servers (playwright.config.ts); these talk to
 * them from a test.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import type { FakeCall } from "./server";

/** Where the fakes listen. playwright.config.ts sets E2E_FAKES_URL for every worker. */
export function fakesUrl(): string {
  const url = process.env.E2E_FAKES_URL;
  if (!url)
    throw new Error("E2E_FAKES_URL is not set: run the specs through playwright.config.ts.");
  return url;
}

/** One isolated fake mailbox for one test (its own customer, sent mail and Gmail drafts). */
export async function registerScenario(
  request: APIRequestContext,
  ownerEmail: string,
): Promise<{ id: string; ref: string }> {
  const id = randomUUID();
  const res = await request.post(`${fakesUrl()}/__scenarios`, { data: { id, ownerEmail } });
  if (res.status() !== 201) throw new Error(`Fake scenario not registered (${res.status()}).`);
  return (await res.json()) as { id: string; ref: string };
}

/** Everything the app (and the browser's consent page) asked the fakes for, in this scenario. */
export async function calls(request: APIRequestContext, scenarioId: string): Promise<FakeCall[]> {
  const res = await request.get(`${fakesUrl()}/__calls?scenario=${scenarioId}`);
  if (!res.ok()) throw new Error(`Fake calls unavailable (${res.status()}).`);
  return ((await res.json()) as { calls: FakeCall[] }).calls;
}

/**
 * The browser never reaches Google or Anthropic: Google's consent page is answered by the
 * fake's consent page (same query string), and any other request to Google or Anthropic is
 * aborted and its host listed in `blocked`, so a stray one never goes out and the spec can
 * assert there were none. Page routes win over context
 * routes, so the consent route still applies.
 */
export async function routeGoogleConsent(page: Page, context: BrowserContext) {
  /** Hosts of the requests that were stopped: the spec asserts there were none. */
  const blocked: string[] = [];
  await context.route(
    /^https?:\/\/([^/]*\.)?(google\.com|googleapis\.com|anthropic\.com)\//,
    (r) => {
      blocked.push(new URL(r.request().url()).host);
      return r.abort();
    },
  );
  await page.route("https://accounts.google.com/o/oauth2/v2/auth**", async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({ url: `${fakesUrl()}/o/oauth2/v2/auth${asked.search}` });
    await route.fulfill({ response });
  });
  return { blocked };
}

export type HookStep =
  | { step: "backfill" | "sync" | "classify" | "draft"; mailboxId: string }
  | { step: "voice"; workspaceId: string }
  | { step: "deliver"; draftId: string };

export type HookResult = { ok: boolean; status?: string; reason?: string } & Record<
  string,
  unknown
>;

/**
 * Runs one job step in the app (src/server/test-hooks.ts). 200 = done, 409 = it ran but
 * stopped (its real status is in the body, e.g. deliver → not_due). Anything else throws with
 * the step and the error name, so a broken step shows its cause instead of a timeout.
 */
export async function runHook(request: APIRequestContext, body: HookStep): Promise<HookResult> {
  const secret = process.env.SA_E2E_HOOK_SECRET;
  if (!secret) throw new Error("SA_E2E_HOOK_SECRET is not set: run through playwright.config.ts.");
  const res = await request.post("/api/test-hooks/run", {
    headers: { "x-e2e-hook-secret": secret },
    data: body,
  });
  if (res.status() === 404) {
    throw new Error(
      "The test hooks are off: start the app with the e2e env (docs/SETUP.md). An app already " +
        "running on this port without it is reused by Playwright outside CI; stop it first.",
    );
  }
  const json = (await res.json().catch(() => ({}))) as HookResult & { error?: string };
  if (res.status() === 200 || res.status() === 409) return json;
  throw new Error(
    `Test hook '${body.step}' failed (${res.status()}): ${json.error ?? "no detail"}`,
  );
}
