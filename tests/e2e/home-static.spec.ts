import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/** Check 29 P3: "/" is prerendered; the signed-in redirect is the proxy's. */

const heading = "your inbox, handled.";

test("the build prerenders / (served from the CDN)", () => {
  const manifest = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8")) as {
    routes: Record<string, unknown>;
  };
  expect(Object.keys(manifest.routes)).toContain("/");
  expect(existsSync(".next/server/app/index.html")).toBe(true);
});

test("signed out, / shows the homepage", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
});

test("signed in, / goes to the queue; after Sign out / shows the homepage again", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/");
  await expect(page).toHaveURL(/\/queue/);
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
});

test("a stale session cookie (account gone) ends on sign-in, never a loop", async ({
  page,
  context,
}) => {
  await signInAs(context, { userId: randomUUID(), email: "gone@example.com" });
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await context.clearCookies();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
});
