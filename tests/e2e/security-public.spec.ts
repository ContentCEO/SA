import { expect, test } from "@playwright/test";

/**
 * Milestone 11 S4: the security checks that touch no database, so a smoke run against a deployed
 * site (PLAYWRIGHT_BASE_URL) runs them too (tests/e2e/smoke-specs.ts): the headers on every
 * response and the test hook's 404. Imports nothing but Playwright
 * (tests/unit/e2e-harness.test.ts checks).
 */

test("every response carries the security headers, HSTS included", async ({ request }) => {
  for (const path of ["/", "/signin", "/api/health"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"], path).toContain("default-src 'self'");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["strict-transport-security"], path).toBe("max-age=31536000");
    // Check 26 P9.
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(h["x-powered-by"], path).toBeUndefined();
  }
});

test("robots.txt doesn't name /admin (Check 26 P9)", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  expect(await res.text()).not.toMatch(/admin/i);
});

test("the test hook stays hidden without its secret, even with the e2e switch on", async ({
  request,
}) => {
  const step = { step: "sync", mailboxId: crypto.randomUUID() };
  // Positive control (local runs only; a deployed site must 404 every time): with the real
  // secret the hook answers — the step's own status for a mailbox that isn't there — so the
  // 404s below are the secret check refusing, not e2e mode being off.
  if (!process.env.PLAYWRIGHT_BASE_URL) {
    const secret = process.env.SA_E2E_HOOK_SECRET;
    expect(secret, "playwright.config.ts sets the hook secret").toBeTruthy();
    const real = await request.post("/api/test-hooks/run", {
      data: step,
      headers: { "x-e2e-hook-secret": secret! },
    });
    expect(real.status()).toBe(409);
    expect(await real.json()).toMatchObject({ ok: false, status: "skipped", reason: "not_found" });
  }
  const none = await request.post("/api/test-hooks/run", { data: step });
  expect(none.status()).toBe(404);
  expect(await none.text()).toBe("");
  const wrong = await request.post("/api/test-hooks/run", {
    data: step,
    headers: { "x-e2e-hook-secret": "x".repeat(64) },
  });
  expect(wrong.status()).toBe(404);
  expect(await wrong.text()).toBe("");
});
