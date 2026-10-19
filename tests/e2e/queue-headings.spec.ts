import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

/** Check 32 P9 + P11: one heading per customer card; long names wrap, never cut off. */

const SPACING = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important;
  word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`;

async function noNameCut(page: Page, selector: string) {
  const cut = await page
    .locator(selector)
    .evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    );
  expect(cut).toEqual([]);
}

test("queue and inbox: a heading per card, and names wrap with wide text spacing", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { complaint } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.messages)
    .set({ fromName: "Chelmsford Building Department Permits Office" })
    .where(eq(schema.messages.id, complaint.m.id));
  await signInAs(context, owner);

  await page.goto("/queue");
  const cards = page.locator("main article");
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  expect(n).toBeGreaterThanOrEqual(2);
  expect(await page.locator("main article h3").count()).toBe(n);
  await expect(
    page.getByRole("article", { name: "Chelmsford Building Department Permits Office" }),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toBeVisible();
  await page.addStyleTag({ content: SPACING });
  await noNameCut(page, "main article h3");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.goto("/inbox");
  const rows = page.locator("main li > details");
  await expect(rows.first()).toBeVisible();
  const rowCount = await rows.count();
  expect(await page.locator("main li > details > summary h2").count()).toBe(rowCount);
  await page.addStyleTag({ content: SPACING });
  await noNameCut(page, "main li > details > summary h2");
});
