import { expect, test } from "@playwright/test";
import { seedOwner, seedQueue, signInAs } from "./support";

test("sunlight mode: one tap, remembered on this device, nothing spills off screen", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");

  const toggle = page.getByRole("button", { name: "Sunlight" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await toggle.click();
  await expect(page.getByRole("button", { name: "Sunlight" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));

  await page.goto("/settings");
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  for (const path of ["/queue", "/settings"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, path).toBe(false);
  }

  await page.getByRole("button", { name: "Sunlight" }).click();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(0);
});
