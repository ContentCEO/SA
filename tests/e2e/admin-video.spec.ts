import { expect, test } from "@playwright/test";
import { seedAdmin, seedOwner, signInAs } from "./support";

/** Check 28 P7: the demo video script as a tick list, admin only. */
test("/admin/video: 404 for an owner; the admin sees the shots and ticks stay on this device", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  expect((await page.goto("/admin/video"))?.status()).toBe(404);

  await context.clearCookies();
  await signInAs(context, await seedAdmin());
  await page.goto("/admin");
  await page.getByRole("link", { name: "Video script (for filming)" }).click();
  await expect(page).toHaveURL(/\/admin\/video$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("shot by shot.");
  // The three fixed reminders.
  await expect(page.getByText(/normal desktop browser tab/)).toBeVisible();
  await expect(page.getByText(/YouTube as Unlisted/)).toBeVisible();
  // Step 4's text, from the doc.
  const step4 = page.getByRole("checkbox", { name: /^4\. Google's real consent screen\./ });
  await expect(step4).toBeVisible();
  await expect(page.getByText(/client_id=/)).toBeVisible();
  expect((await step4.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("0 of 17 ticked")).toBeVisible();

  await step4.check();
  await expect(page.getByText("1 of 17 ticked")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /^4\. / })).toBeChecked();
  await page.getByRole("button", { name: "Clear ticks" }).click();
  await expect(page.getByRole("checkbox", { name: /^4\. / })).not.toBeChecked();
  await expect(page.getByText("0 of 17 ticked")).toBeVisible();
});
