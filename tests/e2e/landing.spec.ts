import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = () => `lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

test("home page: promise, pricing from config, and a way in", async ({ page }) => {
  await page.goto("/");
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText("your inbox,");
  await expect(h1).toContainText("handled.");
  await expect(page.getByText("your okay first.")).toBeVisible();

  const pricing = page.getByRole("region", { name: "Pricing" });
  for (const text of ["$499 once", "Solo", "$99", "Crew", "$199", "Company", "$299"]) {
    await expect(pricing).toContainText(text);
  }
  await page
    .getByRole("navigation", { name: "Site" })
    .getByRole("link", { name: "Sign in" })
    .click();
  await expect(page).toHaveURL(/\/signin$/);

  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("waitlist: plain errors, then a confirmation, saved once", async ({ page }) => {
  const email = unique();
  await page.goto("/#waitlist");
  const form = page.getByRole("region", { name: "Join the waitlist" });

  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByText("Tell us your name.")).toBeVisible();
  await expect(form.getByLabel("Your name")).toBeFocused();

  await form.getByLabel("Your name").fill("Mike Torres");
  await form.getByLabel(/Business Gmail/).fill(email);
  await form.getByLabel("Trade").selectOption("electrical");
  await form.getByLabel("People in the business").selectOption("2–5");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByText("you're on the list,")).toBeVisible();

  const rows = await testDb.select().from(schema.waitlist).where(eq(schema.waitlist.email, email));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: "Mike Torres", trade: "electrical", teamSize: "2–5" });
});

test("waitlist: bots that fill the hidden field are ignored", async ({ page }) => {
  const email = unique();
  await page.goto("/#waitlist");
  const form = page.getByRole("region", { name: "Join the waitlist" });
  await form.getByLabel("Your name").fill("Bot");
  await form.getByLabel(/Business Gmail/).fill(email);
  await page.locator('input[name="website"]').fill("http://spam.example", { force: true });
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByText("you're on the list,")).toBeVisible();
  expect(
    await testDb.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)),
  ).toHaveLength(0);
});

test("admin invites someone straight from the waitlist", async ({ page, context }) => {
  const email = unique();
  await testDb.insert(schema.waitlist).values({ email, name: "Rosa Lima", trade: "plumbing" });
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#waitlist");
  const entry = page.getByRole("listitem", { name: `Waitlist: ${email}` });
  await entry.getByRole("button", { name: "Invite Rosa" }).click();
  await expect(page.getByRole("listitem", { name: `Waitlist: ${email}` })).toContainText("Invited");
  const [invite] = await testDb
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email));
  expect(invite?.trade).toBe("plumbing");
});
