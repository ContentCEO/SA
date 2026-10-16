import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

test("settings: follow-ups can be switched off and the wait changed", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);

  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /^Follow-ups/ })).toContainText(
    "On · after 3 quiet days",
  );
  await page.getByRole("link", { name: /^Follow-ups/ }).click();
  await expect(page).toHaveURL(/\/settings\/follow-ups$/);
  const section = page.getByRole("main");
  const toggle = section.getByLabel("Nudge quotes and invoices that go quiet");
  await expect(toggle).toBeChecked();
  await expect(section.getByLabel("Wait this long for a reply")).toHaveValue("3");
  await expect(section).toContainText("nothing sends without you");
  await page.waitForLoadState("networkidle");

  // The switch saves itself.
  await toggle.uncheck();
  await expect(page).toHaveURL(/\/settings\/follow-ups\?done=saved$/);
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const profile = async () =>
    (
      await testDb
        .select()
        .from(schema.businessProfiles)
        .where(eq(schema.businessProfiles.workspaceId, owner.workspaceId))
    )[0];
  expect(await profile()).toMatchObject({ followupsEnabled: false, followupDays: 3 });
  await expect(section.getByLabel("Nudge quotes and invoices that go quiet")).not.toBeChecked();

  // The wait is a list, so it waits for its Save button.
  await section.getByLabel("Wait this long for a reply").selectOption("5");
  expect(await profile()).toMatchObject({ followupDays: 3 });
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await profile())?.followupDays).toBe(5);
  expect(await profile()).toMatchObject({ followupsEnabled: false });
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /^Follow-ups/ })).toContainText("Off");
});

test("before the page's script runs, the follow-ups switch saves with its button", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  // No app script ever loads (a slow or failed download): React never takes over the page, so
  // the form is a plain HTML form posting to the server action.
  await context.route("**/_next/static/chunks/**", (route) => route.abort());
  await page.goto("/settings/follow-ups");
  await page.getByLabel("Nudge quotes and invoices that go quiet").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/follow-ups\?done=saved$/);
  await expect(page.getByText("Saved.")).toBeVisible();
  const [p] = await testDb
    .select()
    .from(schema.businessProfiles)
    .where(eq(schema.businessProfiles.workspaceId, owner.workspaceId));
  expect(p).toMatchObject({ followupsEnabled: false });
});

test("queue: a nudge is labelled as a follow-up", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ kind: "followup", reason: "No reply in 3 days to your panel quote. Gentle nudge." })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card).toContainText("Follow-up · Quote request");
  await expect(card).toContainText("Gentle nudge.");
});
