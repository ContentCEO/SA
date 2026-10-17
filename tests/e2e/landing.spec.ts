import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { firstChargeLine, PLAN_IDS } from "../../src/server/billing-rules";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = () => `lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

test("home page: promise, pricing from config, and a way in", async ({ page }) => {
  await page.goto("/");
  const h1 = page.getByRole("heading", { level: 1 });
  // A real space between the two lines, for screen readers and search engines.
  await expect(h1).toHaveText("your inbox, handled.");
  expect(await h1.evaluate((el) => el.textContent)).toBe("your inbox, handled.");
  await expect(
    page.getByRole("heading", { level: 2, name: "the one rule, your okay first." }),
  ).toHaveCount(0); // a <p>, not a heading; its text still reads with a space:
  await expect(page.getByText("the one rule, your okay first.")).toBeVisible();

  const pricing = page.getByRole("region", { name: "Pricing" });
  for (const text of ["$499 once", "Solo", "$99", "Crew", "$199", "Company", "$299"]) {
    await expect(pricing).toContainText(text);
  }
  // Check 35 P2: each card says the first payment in /billing's words (built from the config),
  // and with it the sales tax (Stripe Tax, Davi 2026-10-14), once per card and not again below.
  for (const id of PLAN_IDS) {
    await expect(pricing.getByText(firstChargeLine(id, true), { exact: true })).toBeVisible();
  }
  await expect(pricing.getByText("Plus sales tax where it applies.")).toHaveCount(0);
  // Check 6 P9: one name for the join action.
  const nav = page.getByRole("navigation", { name: "Site" });
  await expect(nav.getByRole("link", { name: "Join the waitlist" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Get on the list" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/signin$/);

  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("home page: the queue picture shows Send reply, and the trade cards come first (375px)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  // Check 6 P4: the picture shows the main action; the caption says the trial rule once.
  const figure = page.locator("figure").first();
  await expect(figure).toContainText("Send reply");
  await expect(figure.locator("p").last()).toContainText("won't send to a customer");
  // Check 34 P2: the first "what it does" card is what a trade inbox tool does.
  const cards = page.getByRole("region", { name: "What it does" }).getByRole("heading", {
    level: 3,
  });
  await expect(cards.first()).toHaveText("Knows your trade");
  // Check 6 P9: the header's join button stays on one line next to the wordmark and Sign in.
  const join = page.getByRole("navigation", { name: "Site" }).getByRole("link", {
    name: "Join the waitlist",
  });
  expect((await join.boundingBox())!.height).toBeLessThanOrEqual(48);
  // Check 34 P5: it's added to the home screen, not found in an app store.
  await expect(page.getByText(/add it to your phone's home screen/)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test.describe("waitlist form", () => {
  // Its own address, so the shared form limit (10 an hour) isn't spent by other tests.
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" } });

  test("waitlist: plain errors, then a confirmation, saved once", async ({ page }) => {
    const email = unique();
    await page.goto("/#waitlist");
    const form = page.getByRole("region", { name: "Join the waitlist" });

    await form.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(form.getByText("Tell us your name.")).toBeVisible();
    await expect(form.getByLabel("Your name")).toBeFocused();

    // Required fields are marked for browsers and screen readers; the server is the real check.
    for (const label of ["Your name", /Business email/, "Trade", "People in the business"])
      await expect(form.getByLabel(label)).toHaveAttribute("required", "");
    await expect(form.getByLabel(/Business email/)).toHaveAttribute("autocomplete", "email");
    await expect(
      form.getByText(
        "Gmail, or your own business address if it runs on Google. On Outlook? Join anyway, it's on the list.",
      ),
    ).toBeVisible();
    await expect(form.getByLabel(/^Phone/)).toHaveAttribute("inputmode", "tel");

    await form.getByLabel("Your name").fill("Mike Torres");
    await form.getByLabel(/Business email/).fill("mike@");
    await form.getByLabel("Trade").selectOption("carpentry");
    await form.getByLabel("People in the business").selectOption("2–5");
    await form.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(form.getByText(/doesn't look like an email address/)).toBeVisible();
    await expect(form.getByLabel(/Business email/)).toBeFocused();

    await form.getByLabel("Your name").fill("Mike Torres");
    await form.getByLabel(/Business email/).fill(email);
    await form.getByLabel("Trade").selectOption("electrical");
    await form.getByLabel("People in the business").selectOption("2–5");
    await form.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(form.getByText("You're on the list. Davi will be in touch.")).toBeVisible();

    const rows = await testDb
      .select()
      .from(schema.waitlist)
      .where(eq(schema.waitlist.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Mike Torres", trade: "electrical", teamSize: "2–5" });
  });

  test("waitlist: bots that fill the hidden field are ignored", async ({ page }) => {
    const email = unique();
    await page.goto("/#waitlist");
    const form = page.getByRole("region", { name: "Join the waitlist" });
    await form.getByLabel("Your name").fill("Bot");
    await form.getByLabel(/Business email/).fill(email);
    // Two forms on the page now (the app waitlist and Growth): use this form's hidden field.
    await form.locator('input[name="website"]').fill("http://spam.example", { force: true });
    await form.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(form.getByText("You're on the list. Davi will be in touch.")).toBeVisible();
    expect(
      await testDb.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)),
    ).toHaveLength(0);
  });
});

test.describe("waitlist thank-you", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.13" } });

  // 812: a phone. 1100: a tall phone or a small tablet, where the form turning into the short
  // thank-you pulls the Growth part up past the switch line with no scroll at all.
  for (const height of [812, 1100]) {
    test(`the thank-you stays on screen and the Growth switch doesn't play for the page shrinking (375×${height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height });
      const email = unique();
      await page.goto("/?utm_source=flyer&utm_medium=print&utm_campaign=fall");
      // Let the homepage switch settle (instant decisions until then).
      await page.waitForTimeout(800);
      const form = page.getByRole("region", { name: "Join the waitlist" });
      await form.getByLabel("Your name").fill("Mike Torres");
      await form.getByLabel(/Business email/).fill(email);
      await form.getByLabel("Trade").selectOption("carpentry");
      await form.getByLabel("People in the business").selectOption("2–5");
      const join = form.getByRole("button", { name: "Join the waitlist" });
      await join.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "app");
      // Record every change of the switch's attributes from here on.
      await page.evaluate(() => {
        const w = window as unknown as { __attrs: string[] };
        w.__attrs = [];
        new MutationObserver((ms) => {
          for (const m of ms) {
            w.__attrs.push(
              `${m.attributeName}=${document.documentElement.getAttribute(m.attributeName!)}`,
            );
          }
        }).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-sa-theme", "data-sa-switching"],
        });
      });
      await join.click();
      const done = form.getByRole("status");
      await expect(done).toContainText("You're on the list.");
      await expect(done).toBeFocused();
      await expect(done).toBeInViewport();
      await page.waitForTimeout(1500);
      await expect(done).toBeInViewport();
      await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "app");
      const attrs = await page.evaluate(() => (window as unknown as { __attrs: string[] }).__attrs);
      expect(
        attrs.filter((a) => a.startsWith("data-sa-switching=") && !a.endsWith("=null")),
      ).toEqual([]);
      expect(attrs).not.toContain("data-sa-theme=growth");

      // Where they came from is saved with the entry.
      const [row] = await testDb
        .select()
        .from(schema.waitlist)
        .where(eq(schema.waitlist.email, email));
      expect(row).toMatchObject({ utmSource: "flyer", utmMedium: "print", utmCampaign: "fall" });

      // A real scroll down into Growth still plays the switch.
      await page.mouse.move(180, 400);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(100);
      }
      await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "growth", {
        timeout: 5000,
      });
    });
  }
});

test.describe("waitlist referral link", () => {
  // Its own address, so the shared form limit (10 an hour) isn't spent by other tests.
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" } });

  test("waitlist: a referral link does nothing while referrals are off (#47)", async ({ page }) => {
    // The e2e server runs without FEATURE_REFERRALS and REFERRAL_CREDIT_CENTS is null.
    const email = unique();
    await page.goto("/?ref=AbCdEf123_-x#waitlist");
    const form = page.getByRole("region", { name: "Join the waitlist" });
    await expect(page.locator('input[name="ref"]')).toHaveCount(0);
    await form.getByLabel("Your name").fill("Ana Ruiz");
    await form.getByLabel(/Business email/).fill(email);
    await form.getByLabel("Trade").selectOption("carpentry");
    await form.getByLabel("People in the business").selectOption("Just me");
    await form.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(form.getByText("You're on the list. Davi will be in touch.")).toBeVisible();
    const [row] = await testDb
      .select()
      .from(schema.waitlist)
      .where(eq(schema.waitlist.email, email));
    expect(row?.referralCode).toBeNull();
  });
});

test("admin invites someone straight from the waitlist", async ({ page, context }) => {
  const email = unique();
  await testDb.insert(schema.waitlist).values({
    email,
    name: "Rosa Lima",
    trade: "plumbing",
    utmSource: "facebook",
    utmCampaign: "fall-flyer",
    referrerHost: "facebook.com",
  });
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#waitlist");
  const entry = page.getByRole("listitem", { name: `Waitlist: ${email}` });
  await expect(entry).toContainText("Came from: facebook · fall-flyer (via facebook.com)");
  await entry.getByRole("button", { name: "Invite Rosa" }).click();
  await expect(page.getByRole("listitem", { name: `Waitlist: ${email}` })).toContainText("Invited");
  const [invite] = await testDb
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email));
  expect(invite?.trade).toBe("plumbing");
});
