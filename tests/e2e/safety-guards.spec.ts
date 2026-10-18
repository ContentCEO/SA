import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/**
 * Wave 1 "Safety guards", Check 38 P3: a remodeler's job emails nearly all name big numbers, so
 * setup asks for the "send me anything over" amount up front with suggestions. Other trades
 * keep it folded under "More details, optional". The stored default is unchanged.
 */
test("setup asks a remodeler for the amount up front, with suggestions", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/welcome/profile");

  const amount = page.getByLabel("Send me anything that mentions more than");
  await page.getByLabel("What's your trade?").selectOption("electrical");
  await expect(amount).toBeHidden();

  await page.getByLabel("What's your trade?").selectOption("remodeling");
  await expect(amount).toBeVisible();
  await expect(page.getByText("Most of your job emails mention big numbers.")).toBeVisible();
  await page.getByRole("button", { name: "$25,000" }).click();
  await expect(amount).toHaveValue("25,000");
  await expect(page.getByRole("button", { name: "$25,000" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
