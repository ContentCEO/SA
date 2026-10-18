import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

/**
 * Check 32 P1: a card button that turns into a small question moves focus into it, and closing
 * the question (its own button or Escape) puts focus back on the button that opened it. Focus is
 * never left on the page itself.
 */

/** The text of whatever has focus, and whether it's the page itself. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      body: !el || el === document.body,
      text: (el?.textContent ?? "").trim(),
      tag: el?.tagName ?? "",
      label: el?.getAttribute("aria-label") ?? "",
    };
  });

async function expectFocusInside(page: Page, region: Locator) {
  await expect.poll(() => region.evaluate((r) => r.contains(document.activeElement))).toBe(true);
  expect((await focused(page)).body).toBe(false);
}

async function expectFocusOn(page: Page, name: string) {
  await expect.poll(async () => (await focused(page)).text).toBe(name);
}

test("queue card questions keep keyboard focus (Check 32 P1)", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ body: "Hey Priya,\n\nI can come by at {{time}} on Tuesday.\n\nThanks, Davi" })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: /Priya/ });
  await expect(card).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Discard: the question is the form's name and gets focus; Keep it returns to Discard.
  await card.getByRole("button", { name: "Discard", exact: true }).focus();
  await page.keyboard.press("Enter");
  const discardForm = card.getByRole("form", { name: /Discard this draft/ });
  await expect(discardForm).toBeVisible();
  await expectFocusInside(page, discardForm);
  expect((await focused(page)).text).toContain("Discard this draft?");
  // The next Tab is the question's first button, not something above it.
  await page.keyboard.press("Tab");
  await expectFocusOn(page, "Discard draft");
  await card.getByRole("button", { name: "Keep it" }).focus();
  await page.keyboard.press("Enter");
  await expectFocusOn(page, "Discard");
  // Escape does the same as Keep it.
  await page.keyboard.press("Enter");
  await expectFocusInside(page, card.getByRole("form", { name: /Discard this draft/ }));
  await page.keyboard.press("Escape");
  await expect(card.getByRole("form", { name: /Discard this draft/ })).toHaveCount(0);
  await expectFocusOn(page, "Discard");

  // Remind me later → Never mind, and Escape.
  await card.getByRole("button", { name: "Remind me later" }).focus();
  await page.keyboard.press("Enter");
  const remind = card.getByRole("form", { name: "Remind me…" });
  await expectFocusInside(page, remind);
  await card.getByRole("button", { name: "Never mind" }).focus();
  await page.keyboard.press("Enter");
  await expectFocusOn(page, "Remind me later");
  await page.keyboard.press("Enter");
  await expectFocusInside(page, card.getByRole("form", { name: "Remind me…" }));
  await page.keyboard.press("Escape");
  await expectFocusOn(page, "Remind me later");

  // I called them → Keep it.
  await card.getByRole("button", { name: "I called them" }).focus();
  await page.keyboard.press("Enter");
  const called = card.getByRole("form", { name: /Answered by phone/ });
  await expectFocusInside(page, called);
  await called.getByRole("button", { name: "Keep it" }).focus();
  await page.keyboard.press("Enter");
  await expectFocusOn(page, "I called them");

  // Edit → the reply box; Cancel → Edit.
  await card.getByRole("button", { name: "Edit", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByLabel("Your reply")).toBeFocused();
  await card.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expectFocusOn(page, "Edit");

  // A gap chip → its input; Cancel → the chip; Escape too.
  const chip = card.getByRole("button", { name: "Fill in time" });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByLabel(/What should “time” say\?/)).toBeFocused();
  await card.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByLabel(/What should “time” say\?/)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(chip).toBeFocused();
});
