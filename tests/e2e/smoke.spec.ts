import { expect, test } from "@playwright/test";

test("sign-in page shows the headline and a named button", async ({ page }) => {
  await page.goto("/");
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText("your inbox,");
  await expect(h1).toContainText("handled.");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByText("© 2026 Squared Away — Davi Chaves, Massachusetts")).toBeVisible();
});

test("signed-out visitors can't reach the app", async ({ page }) => {
  for (const path of ["/settings", "/connect"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/);
  }
});

test("not-invited page explains plainly", async ({ page }) => {
  await page.goto("/not-invited");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("you're on the list.");
});

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ ok: true, service: "squared-away" });
});
