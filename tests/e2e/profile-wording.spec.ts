import { expect, test } from "@playwright/test";
import { seedOwner, seedQueue, signInAs } from "./support";

test("getting started: steps tick themselves from real data", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  const list = page.getByRole("region", { name: "Getting started" });
  await expect(list.getByRole("link", { name: "Connect Gmail — done" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Tell us what you do" })).toBeVisible();
  await expect(list).toContainText("0 of 3");
  await expect(list.getByRole("button", { name: "Hide this list" })).toHaveCount(0);
});

test("never-say list and seasonal notes in Settings", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/settings");

  await page.getByLabel("Your never-say list").fill("No worries\nno worries\nPer my last email");
  await page.getByRole("button", { name: "Save never-say list" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Never-say list saved." })).toBeVisible();
  await expect(page.getByLabel("Your never-say list")).toHaveValue("No worries\nPer my last email");

  const notes = page.getByRole("region", { name: "Seasonal notes" });
  await notes.getByLabel("Note").fill("Booked through November");
  await notes.getByLabel("Last day it applies").fill("2099-01-01");
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "within the next year" })).toBeVisible();

  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await notes.getByLabel("Note").fill("Booked through November");
  await notes.getByLabel("Last day it applies").fill(nextMonth);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes).toContainText(`Until ${nextMonth}`);
  await notes.getByRole("button", { name: "Remove note: Booked through November" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Note removed." })).toBeVisible();
});

test("draft editor: Never say this adds the selected words", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByRole("button", { name: "Never say this" }).click();
  await expect(card.getByRole("status")).toContainText("Select the words first");

  const editor = card.getByLabel("Your reply");
  await editor.evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf("address");
    el.setSelectionRange(i, i + "address".length);
  });
  await card.getByRole("button", { name: "Never say this" }).click();
  await expect(card.getByRole("status")).toContainText("Future drafts won't say it.");
  await page.goto("/settings");
  await expect(page.getByLabel("Your never-say list")).toHaveValue("address");
});
