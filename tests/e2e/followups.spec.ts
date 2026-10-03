import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

test("settings: follow-ups can be switched off and the wait changed", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);

  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Follow-ups" });
  const toggle = section.getByLabel("Nudge quotes and invoices that go quiet");
  await expect(toggle).toBeChecked();
  await expect(section.getByLabel("Wait this long for a reply")).toHaveValue("3");
  await expect(section).toContainText("nothing sends without you");

  await toggle.uncheck();
  await section.getByLabel("Wait this long for a reply").selectOption("5");
  await section.getByRole("button", { name: "Save follow-ups" }).click();
  await expect(page.getByText("Follow-up settings saved.")).toBeVisible();

  const [p] = await testDb
    .select()
    .from(schema.businessProfiles)
    .where(eq(schema.businessProfiles.workspaceId, owner.workspaceId));
  expect(p).toMatchObject({ followupsEnabled: false, followupDays: 5 });
  await expect(
    page
      .getByRole("region", { name: "Follow-ups" })
      .getByLabel("Nudge quotes and invoices that go quiet"),
  ).not.toBeChecked();
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
