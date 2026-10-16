import { expect, test } from "@playwright/test";
import { seedAdmin, seedOwner, signInAs } from "./support";

/** Outside review: five tabs (Queue, Inbox, Quotes, Money, More) with readable labels. */
test("five tabs: Money is one, the rest live under More", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/money");

  const nav = page.getByRole("navigation", { name: "Main" });
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Queue", "Inbox", "Quotes", "Money", "More"]);
  await expect(nav.getByRole("link", { name: "Money" })).toHaveAttribute("aria-current", "page");
  for (const link of await links.all()) {
    const size = await link.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(13);
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  await nav.getByRole("link", { name: "More" }).click();
  await expect(page).toHaveURL(/\/more$/);
  const more = page.getByRole("navigation", { name: "More" });
  await expect(more.getByRole("link")).toHaveCount(3);
  for (const name of [/^Customers/, /^Activity/, /^Settings/])
    await expect(more.getByRole("link", { name })).toBeVisible();
  await more.getByRole("link", { name: /^Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(nav.getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("More shows Admin to the admin only", async ({ page, context }) => {
  await signInAs(context, await seedAdmin());
  await page.goto("/more");
  await expect(
    page.getByRole("navigation", { name: "More" }).getByRole("link", { name: /^Admin/ }),
  ).toBeVisible();
});

test("an old Settings link opens the screen that holds it now", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  // The morning email used to link /settings#digest.
  await page.goto("/settings#digest");
  await expect(page).toHaveURL(/\/settings\/morning-email$/);
  await expect(page.getByLabel("Email me a summary each morning")).toBeVisible();
  await page.goto("/settings#never-say");
  await expect(page).toHaveURL(/\/settings\/writing$/);
  // Old bookmarks with a notice still read on the list.
  await page.goto("/settings?done=connected");
  await expect(page.getByRole("status")).toHaveText("Gmail connected.");
});
