import { expect, test, type Locator } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

/** A finger swipe across the card (touch pointer events; a mouse never swipes). */
async function swipe(card: Locator, dx: number) {
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 40;
  const at = (clientX: number) => ({ pointerType: "touch", clientX, clientY: y, bubbles: true });
  await card.dispatchEvent("pointerdown", at(x));
  await card.dispatchEvent("pointermove", at(x + dx / 2));
  await card.dispatchEvent("pointermove", at(x + dx));
  await card.dispatchEvent("pointerup", at(x + dx));
}

for (const hand of ["right", "left"] as const) {
  test(`${hand} hand: swipe toward the thumb opens for sending; the other way discards with undo`, async ({
    page,
    context,
    baseURL,
  }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await seedQueue(owner.mailboxId!);
    await signInAs(context, owner);
    if (hand === "left") {
      await context.addCookies([{ name: "sa_hand", value: "left", url: baseURL! }]);
    }
    const open = hand === "right" ? 140 : -140;

    await page.goto("/queue");
    const card = page.getByRole("article", { name: "Draft reply to Priya" });
    await expect(card.getByRole("button", { name: "Show full draft" })).toBeVisible();

    await swipe(card, open);
    // Opened: the whole draft is showing. Nothing was sent (sending is off for this account anyway).
    await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();
    await expect(card.getByText("Discarding in")).toHaveCount(0);

    await swipe(card, -open);
    await expect(card.getByText(/Discarding in \d/)).toBeVisible();
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card.getByText(/Discarding in/)).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();

    // The main button sits on the thumb's side.
    const edit = (await card.getByRole("button", { name: "Edit" }).boundingBox())!;
    const discard = (await card.getByRole("button", { name: "Discard" }).boundingBox())!;
    expect(edit.x > discard.x).toBe(hand === "right");
  });
}

test("the hand setting saves itself, for this phone", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/settings/phone");
  await page.waitForLoadState("networkidle");
  const section = page.getByRole("region", { name: "On this phone" });
  // Once the page's script runs, the radios need no Save button.
  const saves = section.locator(".sa-autosave-button");
  await expect(saves).toHaveCount(2);
  for (const save of await saves.all()) await expect(save).toBeHidden();
  await section.getByLabel(/Left hand/).check();
  await expect(page).toHaveURL(/\/settings\/phone\?done=saved$/);
  await expect(page.getByText("Saved for this phone.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "On this phone" }).getByLabel(/Left hand/),
  ).toBeChecked();
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /^This phone/ })).toContainText("Left hand");
});

test("Settings' switches and radios are charcoal, with 44px rows (outside review)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  for (const path of ["/settings/phone", "/settings/follow-ups", "/settings/morning-email"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    const boxes = page.locator('main input[type="checkbox"], main input[type="radio"]');
    await expect(boxes.first()).toBeVisible();
    expect(await boxes.count(), path).toBeGreaterThan(0);
    for (const box of await boxes.all()) {
      const input = (await box.boundingBox())!;
      expect(input.height, path).toBeGreaterThanOrEqual(24);
      const label = (await box.locator("xpath=ancestor::label[1]").boundingBox())!;
      expect(label.height, path).toBeGreaterThanOrEqual(44);
      // Two-tone: the theme's ink (charcoal), never the browser's blue.
      expect(await box.evaluate((el) => getComputedStyle(el).accentColor), path).toBe(
        "rgb(27, 27, 27)",
      );
    }
  }
});

test("offline okay (opt-in): held until back online, then refused if the draft changed", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  const { draft } = await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await context.addCookies([{ name: "sa_offline", value: "on", url: baseURL! }]);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("button", { name: "Send reply" })).toBeVisible();

  await context.setOffline(true);
  await card.getByRole("button", { name: "Send reply" }).click();
  await expect(card.getByText("Will send when you're back online.")).toBeVisible();

  // Meanwhile the draft changes (say, rewritten in Gmail and picked up).
  await testDb
    .update(schema.drafts)
    .set({ body: "A different reply." })
    .where(eq(schema.drafts.id, draft.id));
  await context.setOffline(false);
  await expect(
    page.getByText("Your reply to Priya wasn't sent — it changed since you okayed it."),
  ).toBeVisible();
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.sendAfter).toBeNull();
  expect(after!.status).toBe("pending");
});

test("keeping the queue on this phone is off until switched on", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/settings/phone");
  await page.waitForLoadState("networkidle");
  const box = page.getByLabel(/Keep my queue on this phone/);
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page).toHaveURL(/\/settings\/phone\?done=saved$/);
  await expect(page.getByLabel(/Keep my queue on this phone/)).toBeChecked();
});
