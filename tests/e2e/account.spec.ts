import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { newOwnerEmail, seedAdmin, seedOwner, signInAs, testDb } from "./support";

test("delete my account: one clear confirmation, then everything is gone", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/settings");
  await page.getByRole("link", { name: /^Account/ }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);

  await page.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("form", { name: "Delete my account" });
  await expect(confirm).toContainText("This can't be undone");
  await confirm.getByRole("button", { name: "Keep my account" }).click();
  await expect(confirm).toHaveCount(0);

  await page.getByRole("button", { name: "Delete my account" }).click();
  // Check 26 P4: the button stays off until the word is typed (any case).
  const yes = page.getByRole("button", { name: "Yes, delete everything" });
  await expect(yes).toBeDisabled();
  const field = page.getByLabel("Type DELETE to confirm");
  expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await field.fill("delet");
  await expect(yes).toBeDisabled();
  await field.fill("delete");
  await yes.click();
  await expect(page).toHaveURL(/\/goodbye$/);
  await expect(page.getByText("Your account and everything in it is gone")).toBeVisible();

  const rows = await testDb.select().from(schema.users).where(eq(schema.users.id, owner.userId));
  expect(rows).toHaveLength(0);
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/signin$/);
});

test("after Delete my account, the admin's waitlist card offers Invite again", async ({
  page,
  context,
  browser,
}) => {
  const email = newOwnerEmail();
  // Davi invited them from the waitlist, and they signed up.
  await testDb
    .insert(schema.waitlist)
    .values({ email, name: "Nina Park", trade: "plumbing", invitedAt: new Date() });
  const owner = await seedOwner({ email });
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#waitlist");
  const card = page.getByRole("listitem", { name: `Waitlist: ${email}` });
  await expect(card).toContainText("Invited");
  await expect(card.getByRole("button")).toHaveCount(0);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signInAs(ownerContext, owner);
  await ownerPage.goto("/settings/account");
  await ownerPage.getByRole("button", { name: "Delete my account" }).click();
  await ownerPage.getByLabel("Type DELETE to confirm").fill("delete");
  await ownerPage.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(ownerPage).toHaveURL(/\/goodbye$/);
  await ownerContext.close();

  // A real reload: going to the same URL with only a hash is a same-page jump.
  await page.reload();
  await expect(card).toContainText("that invite is gone");
  await card.getByRole("button", { name: "Invite Nina again" }).click();
  await expect(page.getByRole("listitem", { name: `Waitlist: ${email}` })).toContainText(
    /Invited (just now|\d)/,
  );
  await expect(card.getByRole("button")).toHaveCount(0);
  const [invite] = await testDb
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email));
  expect(invite?.trade).toBe("plumbing");
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

test("text alerts stay out of Settings until texting is set up", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/settings");
  const list = page.getByRole("navigation", { name: "Settings" });
  await expect(list.getByRole("link", { name: /^Your Gmail/ })).toBeVisible();
  await expect(list.getByRole("link", { name: /Text alerts/ })).toHaveCount(0);
  await expect(page.getByText("Coming soon")).toHaveCount(0);
  // The screen itself (or an old link to it) goes back to the list.
  await page.goto("/settings/texts");
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto("/settings#texts");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(list.getByRole("link", { name: /^Your Gmail/ })).toBeVisible();
});

test("Sign out of every phone and computer ends the other sign-ins too (Check 26 P3)", async ({
  page,
  context,
  browser,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  // The same owner on a second device (another browser context, its own cookie).
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signInAs(other, owner);
  await otherPage.goto("/settings");
  await expect(otherPage).toHaveURL(/\/settings$/);

  await page.goto("/settings/account");
  const button = page.getByRole("button", { name: "Sign out of every phone and computer" });
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  await expect(page).toHaveURL(/\/signin\?done=everywhere$/);
  await expect(page.getByRole("status")).toHaveText("Signed out everywhere.");

  // The other device lands on /signin on its next navigation.
  await otherPage.goto("/queue");
  await expect(otherPage).toHaveURL(/\/signin$/);
  await other.close();
});

test("Delete my account asks for a fresh sign-in first (Check 26 P4)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner, { signedInMinutesAgo: 60 });
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fsettings%2Faccount&reason=recent$/);
  await expect(page.getByRole("alert").filter({ hasText: "sign in again" })).toHaveText(
    "For your safety, sign in again to delete your account.",
  );
  // Nothing was deleted.
  const rows = await testDb.select().from(schema.users).where(eq(schema.users.id, owner.userId));
  expect(rows).toHaveLength(1);
});
