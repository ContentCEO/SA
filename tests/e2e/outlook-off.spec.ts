import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/**
 * Plan #49, GUARDRAIL: on the normal e2e app Outlook is off (FEATURE_OUTLOOK unset, as in
 * production today): no Outlook button or wording, and the Outlook routes are closed.
 */
test("with Outlook off, Connect is Gmail only and the Outlook routes are closed", async ({
  page,
  context,
  request,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/connect");
  await expect(page).toHaveTitle(/Connect Gmail/);
  await expect(page.getByRole("button", { name: "Connect Gmail" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Outlook/ })).toHaveCount(0);
  await expect(page.getByText(/Microsoft 365/)).toHaveCount(0);
  expect((await request.post("/api/outlook/notify?validationToken=x")).status()).toBe(404);
  // The callback sends a signed-in owner back to Connect without reading anything.
  await page.goto("/api/outlook/callback?state=x&code=y");
  await expect(page).toHaveURL(/\/connect$/);
});
