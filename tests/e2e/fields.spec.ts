import { expect, type Locator, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/** The text of everything a control's aria-describedby points at. */
async function description(el: Locator) {
  return el.evaluate((node) =>
    (node.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
}

/**
 * Check 32 P10: a field's name is just its label; the hint and the error are its description,
 * read once.
 */
test("field names are only the label; the error is described once", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/welcome/profile");
  const name = page.getByRole("textbox", {
    name: "What's the business called? (required)",
    exact: true,
  });
  await expect(name).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "What's your trade? (required)", exact: true }),
  ).toBeVisible();

  await name.fill("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "need fixing" })).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  // Still named by the label alone after the failed save…
  await expect(name).toBeFocused();
  const error = await page.locator("#businessName-error").textContent();
  expect(error?.trim()).toBeTruthy();
  // …and the error is in the description exactly once.
  const desc = await description(name);
  expect(desc.split(error!.trim()).length - 1).toBe(1);

  // The waitlist form on the homepage (signed out: a signed-in owner goes to the queue).
  await context.clearCookies();
  await page.goto("/");
  const email = page.getByRole("textbox", { name: "Business email", exact: true });
  await expect(email).toBeVisible();
  expect(await description(email)).toContain("Gmail, or your own business address");
});
