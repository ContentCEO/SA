import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/**
 * Milestone 11 S4: the security checks a real browser and server can prove — the headers on
 * every response, /admin's 404, the test hook's 404, the send API's Origin check and the
 * Gmail-connect state cookie.
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
  }
});

test("/admin is a plain 404 for an owner who isn't the admin", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  for (const path of ["/admin", "/admin/costs"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: /admin/i })).toHaveCount(0);
  }
});

test("the test hook stays hidden without its secret, even with the e2e switch on", async ({
  request,
}) => {
  const step = { step: "sync", mailboxId: randomUUID() };
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

test("the send API refuses a request with no real Origin (403, never a 500)", async ({
  request,
}) => {
  for (const origin of ["null", "https://evil.example", "::garbled::"]) {
    const res = await request.post(`/api/drafts/${randomUUID()}/send`, {
      headers: { origin },
      data: {},
    });
    expect(res.status(), origin).toBe(403);
  }
});

test("the Gmail-connect state cookie is httpOnly, SameSite=Lax and only sent to /api/gmail", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  // Stop at Google's door: the cookie is set by then.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, body: "google consent (stubbed)" }),
  );
  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByText("google consent (stubbed)")).toBeVisible();

  const state = (await context.cookies()).find((c) => c.name === "sa_gmail_oauth_state");
  expect(state).toBeDefined();
  expect(state!.httpOnly).toBe(true);
  expect(state!.sameSite).toBe("Lax");
  expect(state!.path).toBe("/api/gmail");
  // `pnpm start` runs in production mode, where it's Secure too.
  expect(state!.secure).toBe(true);
  expect(state!.value).toMatch(/^[A-Za-z0-9_-]{40,}$/);
});
