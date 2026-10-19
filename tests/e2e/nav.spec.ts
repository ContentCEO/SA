import { expect, test } from "@playwright/test";
import { seedAdmin, seedOwner, seedQueue, signInAs } from "./support";

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

/**
 * Check 8 P5: a bigger text setting (or Sunlight's bigger type) never cuts a tab label, runs
 * two together or makes the page scroll sideways.
 */
test("the tab bar fits at 150% and 200% text, with and without Sunlight", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "the tab bar shows on phones only");
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  for (const sunlight of [false, true]) {
    if (sunlight) {
      await context.addCookies([
        { name: "sa_contrast", value: "high", domain: "localhost", path: "/" },
      ]);
    }
    for (const size of [
      { width: 320, height: 640 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/queue");
      await expect(page.locator('[data-contrast="high"]')).toHaveCount(sunlight ? 1 : 0);
      for (const scale of ["150%", "200%"]) {
        await page.evaluate((s) => (document.documentElement.style.fontSize = s), scale);
        const where = `${size.width}px ${scale} sunlight=${sunlight}`;
        const tabs = page.locator("[data-tabbar] a");
        await expect(tabs).toHaveCount(5);
        const cut = await tabs.evaluateAll((els) =>
          els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent?.trim()),
        );
        expect(cut, where).toEqual([]);
        const boxes = await tabs.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, height: r.height };
          }),
        );
        for (let i = 0; i < boxes.length; i++) {
          expect(boxes[i]!.height, where).toBeGreaterThanOrEqual(44);
          if (i > 0)
            expect(boxes[i]!.left, where).toBeGreaterThanOrEqual(boxes[i - 1]!.right - 0.5);
        }
        expect(boxes[0]!.left, where).toBeGreaterThanOrEqual(0);
        expect(boxes[4]!.right, where).toBeLessThanOrEqual(size.width + 0.5);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflow, where).toBe(false);
      }
    }
  }
});

/** Check 8 P6: on a slow signal, a tap on More shows something within 300ms. */
test("More shows its loading screen or a dark tab at once on a slow signal", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "the tab bar shows on phones only");
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  // Two seconds for anything /more from here on (its data, and any prefetch not done yet).
  await page.route("**/more**", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const more = page.locator("[data-tabbar]").getByRole("link", { name: "More" });
  const started = Date.now();
  await more.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            !!document.querySelector('main [role="status"][aria-label="Loading"]') ||
            !!Array.from(document.querySelectorAll("[data-tabbar] a")).find(
              (a) => a.textContent?.trim() === "More" && a.querySelector(".sa-inverted"),
            ),
        ),
      { intervals: [25], timeout: 300 },
    )
    .toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(page).toHaveURL(/\/more$/, { timeout: 10_000 });
});

/** Check 8 P10: sideways, the first thing to tap inside the screen is on the first screen. */
for (const size of [
  { width: 568, height: 320 },
  { width: 812, height: 375 },
]) {
  test(`sideways at ${size.width}×${size.height}: something to tap on the first screen`, async ({
    page,
    context,
  }, info) => {
    test.skip(info.project.name !== "mobile", "a phone turned sideways");
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await seedQueue(owner.mailboxId!);
    await signInAs(context, owner);
    await page.setViewportSize(size);
    for (const path of ["/queue", "/inbox"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const first = page.locator("main").locator("a, button").filter({ visible: true }).first();
      const box = (await first.boundingBox())!;
      expect(box.y + 44, `${path}: ${await first.textContent()}`).toBeLessThan(size.height);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(false);
    }
  });
}
