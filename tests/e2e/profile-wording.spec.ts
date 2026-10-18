import { expect, test } from "@playwright/test";
import { untilLine } from "../../src/lib/plain-date";
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
  await page.getByRole("link", { name: /^Your voice/ }).click();
  await expect(page).toHaveURL(/\/settings\/writing$/);

  await page.getByLabel("Your never-say list").fill("No worries\nno worries\nPer my last email");
  await page.getByRole("button", { name: "Save never-say list" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Never-say list saved." })).toBeVisible();
  await expect(page.getByLabel("Your never-say list")).toHaveValue("No worries\nPer my last email");

  await page.goto("/settings/business");
  const notes = page.getByRole("region", { name: "Seasonal notes" });
  await notes.getByLabel("Note").fill("Booked through November");
  await notes.getByLabel("Last day it applies").fill("2099-01-01");
  await notes.getByRole("button", { name: "Add note" }).click();
  // Check 15 P9: the refusal says why under the date, keeps the typed note, and focuses the date.
  await expect(notes.getByText("Pick a date within the next year.")).toBeVisible();
  await expect(notes.getByLabel("Note")).toHaveValue("Booked through November");
  await expect(notes.getByLabel("Last day it applies")).toBeFocused();

  // Too short: the schema's own message, under the note.
  await notes.getByLabel("Note").fill("Hi");
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(
    notes.getByText("Write a short note, like “Booked through November”."),
  ).toBeVisible();
  await expect(notes.getByLabel("Note")).toHaveValue("Hi");

  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await notes.getByLabel("Note").fill("Booked through November");
  await notes.getByLabel("Last day it applies").fill(nextMonth);
  await notes.getByRole("button", { name: "Add note" }).click();
  // A readable date: "Until Sun, Nov 30" (the year only when it isn't this year).
  await expect(notes).toContainText(untilLine(nextMonth, new Date().toISOString().slice(0, 10)));
  await notes.getByRole("button", { name: "Remove note: Booked through November" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Note removed." })).toBeVisible();
});

test("draft editor: Never say this adds the selected words", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
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
  await page.goto("/settings/writing");
  await expect(page.getByLabel("Your never-say list")).toHaveValue("address");
});
