import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

test("delete my account: one clear confirmation, then everything is gone", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/settings");

  await page.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("form", { name: "Delete my account" });
  await expect(confirm).toContainText("This can't be undone");
  await confirm.getByRole("button", { name: "Keep my account" }).click();
  await expect(confirm).toHaveCount(0);

  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page).toHaveURL(/\/goodbye$/);
  await expect(page.getByText("Your account and everything in it is gone")).toBeVisible();

  const rows = await testDb.select().from(schema.users).where(eq(schema.users.id, owner.userId));
  expect(rows).toHaveLength(0);
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/signin$/);
});

test("a session for a deleted account lands on sign-in, not a redirect loop", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await testDb.delete(schema.users).where(eq(schema.users.id, owner.userId));
  await page.goto("/signin");
  await expect(page.getByRole("button", { name: /Sign in with Google/ })).toBeVisible();
});

test("text alerts say plainly when texting isn't set up", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/settings#texts");
  const texts = page.getByRole("region", { name: "Text alerts" });
  await expect(texts).toContainText("never a customer's name");
  await expect(texts).toContainText("aren't switched on yet");
  await expect(texts.getByRole("button")).toHaveCount(0);
});
