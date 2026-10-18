import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

/**
 * Check 45 P1 + Check 44 P5 + Check 15 P7: the owner's time zone comes from their own browser
 * once (while never set), is shown on Settings → Morning email, and changes only on a tap.
 */
const zoneOf = async (workspaceId: string) =>
  (
    await testDb
      .select({
        tz: schema.businessProfiles.timeZone,
        source: schema.businessProfiles.timeZoneSource,
      })
      .from(schema.businessProfiles)
      .where(eq(schema.businessProfiles.workspaceId, workspaceId))
  )[0];

test.describe("an owner who left setup at step 2", () => {
  test.use({ timezoneId: "America/Los_Angeles", viewport: { width: 375, height: 812 } });

  test("gets their browser's zone on the first signed-in page, and a second browser doesn't move it", async ({
    page,
    context,
    browser,
  }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await testDb.insert(schema.businessProfiles).values({ workspaceId: owner.workspaceId });
    expect(await zoneOf(owner.workspaceId)).toEqual({ tz: "America/New_York", source: "default" });
    await signInAs(context, owner);

    await page.goto("/queue");
    await expect
      .poll(async () => (await zoneOf(owner.workspaceId))?.tz)
      .toBe("America/Los_Angeles");
    expect((await zoneOf(owner.workspaceId))?.source).toBe("browser");

    const chicago = await browser.newContext({
      timezoneId: "America/Chicago",
      viewport: { width: 375, height: 812 },
    });
    await signInAs(chicago, owner);
    const other = await chicago.newPage();
    await other.goto("/queue");
    await other.waitForLoadState("networkidle");
    expect(await zoneOf(owner.workspaceId)).toEqual({
      tz: "America/Los_Angeles",
      source: "browser",
    });
    await chicago.close();
  });
});

test.describe("Settings → Morning email shows the zone", () => {
  test.use({ timezoneId: "America/Chicago", viewport: { width: 375, height: 812 } });

  test("offers this phone's zone, a tap switches it, and the form saves without touching it", async ({
    page,
    context,
  }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await testDb.insert(schema.businessProfiles).values({
      workspaceId: owner.workspaceId,
      timeZone: "America/New_York",
      timeZoneSource: "browser",
      digestEnabled: false,
    });
    await signInAs(context, owner);

    await page.goto("/settings/morning-email");
    await expect(page.getByText("Times are in Eastern time (New York, Boston).")).toBeVisible();
    await expect(page.getByText("This phone is on Central time.")).toBeVisible();
    const use = page.getByRole("button", { name: "Use Central time" });
    expect((await use.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await use.click();
    await expect(page).toHaveURL(/done=zone/);
    await expect(page.getByText("Times are in Central time (Chicago, Dallas).")).toBeVisible();
    await expect(page.getByText("This phone is on Central time.")).toBeHidden();
    expect(await zoneOf(owner.workspaceId)).toEqual({ tz: "America/Chicago", source: "owner" });

    // Ticking the morning email saves the form; the zone stays as picked.
    await page.getByLabel("Email me a summary each morning").check();
    await expect(page).toHaveURL(/done=saved/);
    expect((await zoneOf(owner.workspaceId))?.tz).toBe("America/Chicago");

    // Picking another zone and saving updates the Settings list line.
    await page.getByLabel("Your time zone").selectOption("America/Los_Angeles");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await expect(page.getByText("Times are in Pacific time (Los Angeles, Seattle).")).toBeVisible();
    await expect(page.getByText("This phone is on Central time.")).toBeVisible();
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: /^Morning email/ })).toContainText(
      "On · 7:00 am Pacific",
    );
  });
});
