import { expect, test } from "@playwright/test";

test("home renders the signature headline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("your inbox,");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("handled.");
  await expect(page.getByText("© 2026 Squared Away — Davi Chaves, Massachusetts")).toBeVisible();
});

test("no horizontal scroll at phone width", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ ok: true, service: "squared-away" });
});
