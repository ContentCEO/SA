import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { formatGrowthBlock } from "../../src/server/growth-note";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = (p = "growth") =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe("homepage: the way into Squared Away Growth", () => {
  test("hero link, header link, landmarks and no sideways scroll", async ({ page }) => {
    await page.goto("/");
    const hero = page
      .getByRole("region", { name: "Introduction" })
      .getByRole("link", { name: "Want more work coming in? See Squared Away Growth" });
    await expect(hero).toHaveAttribute("href", "#growth");
    expect((await hero.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const header = page.getByRole("navigation", { name: "Site" }).getByRole("link", {
      name: "Growth",
      exact: true,
    });
    const wide = page.viewportSize()!.width >= 640;
    if (wide) await expect(header).toBeVisible();
    else await expect(header).toBeHidden();

    expect(await noOverflow(page)).toBe(true);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(
      page.getByRole("main").getByRole("region", { name: "Book a free call" }),
    ).toHaveCount(1);
    await expect(page.getByRole("banner")).toHaveCount(1);

    await hero.click();
    await expect(
      page.getByRole("region", { name: "Introducing Squared Away Growth" }),
    ).toBeInViewport();
  });

  test("the chapter bar shows over the Growth chapter only", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByRole("navigation", { name: "Growth" });
    const call = bar.getByRole("link", { name: "Book a free call" });
    await expect(call).toHaveAttribute("href", "#growth-call");

    await page.getByRole("region", { name: "Pricing" }).scrollIntoViewIfNeeded();
    await expect(bar).not.toBeInViewport();

    await page.getByRole("region", { name: "Ground rules" }).scrollIntoViewIfNeeded();
    await expect(call).toBeInViewport();
    const box = (await bar.boundingBox())!;
    expect(box.y).toBeLessThan(20);
    // The bar fully covers the paper header: no strip of it peeks out below.
    const heights = await page.evaluate(() => ({
      header: document.querySelector("header")!.getBoundingClientRect().height,
      bar: document.querySelector("[data-growth-chapter] > div")!.getBoundingClientRect().height,
    }));
    expect(heights.bar).toBeGreaterThanOrEqual(heights.header);
    // Solid charcoal: a see-through bar would show the paper header through it as a third grey.
    await expect(page.locator("[data-growth-chapter] > div").first()).toHaveCSS(
      "background-color",
      "rgb(27, 27, 27)",
    );
    expect((await call.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("the flip: charcoal rises with the scroll, driven by CSS", async ({ page }) => {
    await page.goto("/");
    const ink = page.locator(".sa-flip-ink");
    const style = await ink.evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, timeline: s.getPropertyValue("animation-timeline") };
    });
    expect(style).toEqual({ name: "sa-flip-wipe", timeline: "--sa-flip" });

    const translateY = () =>
      ink.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42);
    const band = await page.locator(".sa-flip").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height, vh: window.innerHeight };
    });

    // The band's top edge just entering at the bottom of the screen: all paper.
    await page.evaluate((y) => window.scrollTo(0, y), band.top - band.vh + 2);
    await expect.poll(translateY).toBeGreaterThan(band.height * 0.9);

    // The band's centre at the centre of the screen: all charcoal.
    await page.evaluate((y) => window.scrollTo(0, y), band.top + band.height / 2 - band.vh / 2);
    await expect.poll(translateY).toBeCloseTo(0, 0);

    await expect(page.locator("[data-growth-chapter]")).toHaveCSS(
      "background-color",
      "rgb(27, 27, 27)",
    );
  });

  test("reduced motion: no wipe, just the switch to charcoal", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const ink = page.locator(".sa-flip-ink");
    await expect(ink).toHaveCSS("animation-name", "none");
    await expect(ink).toHaveCSS("transform", "none");
    await expect(ink).toHaveCSS("background-color", "rgb(27, 27, 27)");
  });
});

test.describe("Book a free call", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" } });

  test("plain errors, focus on what needs fixing, then a thank-you and one stored request", async ({
    page,
  }) => {
    const email = unique();
    await page.goto("/#growth-call");
    const form = page.getByRole("region", { name: "Book a free call" });
    const submit = form.getByRole("button", { name: "Book a free call" });

    for (const label of ["Your name", /^Phone/, /^Email/, "Trade"]) {
      await expect(form.getByLabel(label)).toHaveAttribute("required", "");
    }
    await expect(form.getByLabel(/^Phone/)).toHaveAttribute("inputmode", "tel");
    await expect(form.getByLabel(/^Phone/)).toHaveAttribute("autocomplete", "tel");

    await submit.click();
    for (const text of [
      "Tell us your name.",
      "Tell us a phone number so Davi can call you.",
      "Tell us your email address.",
      "Pick your trade.",
      "Pick at least one thing you want help with.",
    ]) {
      await expect(form.getByText(text)).toBeVisible();
    }
    await expect(form.getByLabel("Your name")).toBeFocused();

    const fill = async () => {
      await form.getByLabel("Your name").fill("Mike Torres");
      await form.getByLabel(/^Phone/).fill("(617) 555-0142");
      await form.getByLabel(/^Email/).fill(email);
      await form.getByLabel("Trade").selectOption("roofing");
    };
    await fill();
    await submit.click();
    const google = form.getByRole("checkbox", { name: "Google ads" });
    await expect(google).toBeFocused();

    // Every option is a full-width row at least 44px tall, and a ticked row turns charcoal.
    const row = form
      .locator("label")
      .filter({ has: page.getByRole("checkbox", { name: "Google ads" }) });
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await fill();
    await google.check();
    await form.getByRole("checkbox", { name: "Reviews" }).check();
    await expect(row).toHaveCSS("background-color", "rgb(27, 27, 27)");

    await submit.click();
    const done = form.getByRole("status");
    await expect(done).toContainText("we'll call you.");
    await expect(done).toContainText(
      "Davi will call you at 617-555-0142 to find a time for your free call.",
    );
    // The thank-you is far shorter than the form: it's brought into view, clear of the sticky
    // bar, and focus moves to it (the button that had focus is gone).
    await expect(done).toBeFocused();
    await expect(done.getByText("we'll call you.")).toBeInViewport();
    const top = await done.evaluate((el) => el.getBoundingClientRect().top);
    const barBottom = await page.evaluate(
      () => document.querySelector("[data-growth-chapter] > div")!.getBoundingClientRect().bottom,
    );
    expect(top).toBeGreaterThanOrEqual(barBottom);

    const rows = await testDb
      .select()
      .from(schema.waitlist)
      .where(eq(schema.waitlist.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teamSize).toBe("growth-only");
    expect(rows[0]!.note).toContain("[Growth call]");
    expect(rows[0]!.note).toContain("Help with: Google ads, Reviews");
    expect(
      await testDb.select().from(schema.invites).where(eq(schema.invites.email, email)),
    ).toEqual([]);
  });

  test("bots that fill the hidden field are ignored", async ({ page }) => {
    const email = unique("growth-bot");
    await page.goto("/#growth-call");
    const form = page.getByRole("region", { name: "Book a free call" });
    await form.getByLabel("Your name").fill("Bot");
    await form.getByLabel(/^Phone/).fill("617-555-0142");
    await form.getByLabel(/^Email/).fill(email);
    await form.locator('input[name="website"]').fill("http://spam.example", { force: true });
    await form.getByRole("button", { name: "Book a free call" }).click();
    await expect(form.getByRole("status")).toContainText(
      "Davi will call you soon to find a time for your free call.",
    );
    expect(
      await testDb.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)),
    ).toEqual([]);
  });
});

test("admin: Growth requests and app sign-ups side by side; Growth-only is never invited", async ({
  page,
  context,
}) => {
  const mixed = unique("mixed");
  const only = unique("only");
  const block = (phone: string, at: string, services: string[]) =>
    formatGrowthBlock({ at, services, phone });
  await testDb.insert(schema.waitlist).values([
    {
      email: mixed,
      name: "Rosa Lima",
      trade: "plumbing",
      teamSize: "2–5",
      note: `Two vans\n\n${block("978-555-0100", "2026-10-12 14:05", ["Website"])}`,
    },
    {
      email: only,
      name: "Sam Okafor",
      trade: "roofing",
      phone: "617-555-0142",
      teamSize: "growth-only",
      note: block("617-555-0142", "2026-10-12 09:12", ["Google ads", "Reviews"]),
    },
  ]);
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#waitlist");

  const a = page.getByRole("listitem", { name: `Waitlist: ${mixed}` });
  await expect(a.getByText("Growth call", { exact: true })).toBeVisible();
  await expect(a.getByText("App waitlist", { exact: true })).toBeVisible();
  await expect(a).toContainText("Wants help with: Website");
  await expect(a).toContainText("Asked for a call Oct 12, 2:05 PM");
  await expect(a).toContainText("“Two vans”");
  await expect(a.getByRole("link", { name: "Call 978-555-0100" })).toHaveAttribute(
    "href",
    "tel:+19785550100",
  );
  await expect(a.getByRole("button", { name: "Invite Rosa" })).toBeVisible();

  const b = page.getByRole("listitem", { name: `Waitlist: ${only}` });
  await expect(b.getByText("Growth call", { exact: true })).toBeVisible();
  await expect(b.getByText("App waitlist", { exact: true })).toHaveCount(0);
  await expect(b).toContainText(
    "Not on the app waitlist. A Growth call never invites anyone to the app.",
  );
  await expect(b).toContainText("Wants help with: Google ads, Reviews");
  await expect(b.getByRole("button")).toHaveCount(0);
  await expect(b).not.toContainText("growth-only");
  await expect(page.getByText("Earlier request")).toHaveCount(0);

  // A posted invite for a Growth-only email (e.g. a stale page) invites nobody and says why.
  await a.locator('input[name="email"]').evaluate((el, v) => {
    (el as HTMLInputElement).value = v;
  }, only);
  await a.getByRole("button", { name: "Invite Rosa" }).click();
  await expect(page).toHaveURL(/\/admin\?error=growth_only#waitlist$/);
  await expect(
    page.getByText("That's a Growth call request, not an app sign-up, so nobody was invited."),
  ).toBeVisible();
  expect(await testDb.select().from(schema.invites).where(eq(schema.invites.email, only))).toEqual(
    [],
  );
});

test("/growth: its own page, charcoal edge to edge", async ({ page }) => {
  const res = await page.goto("/growth");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(
    "Squared Away Growth — ads, reviews and your website, done for you.",
  );
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText("the marketing side,");
  await expect(h1).toContainText("done for you.");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/growth$/);
  await expect(
    page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Book a free call" }),
  ).toHaveAttribute("href", "#growth-call");

  const call = page.getByRole("region", { name: "Book a free call" });
  await expect(call.getByRole("link", { name: "Call 978-201-9763" })).toHaveAttribute(
    "href",
    "tel:+19782019763",
  );
  await expect(call.getByRole("link", { name: "Text 978-201-9763" })).toHaveAttribute(
    "href",
    "sms:+19782019763",
  );
  await expect(page.getByRole("region", { name: "Who does the work" })).toContainText(
    "A&C Construction",
  );
  expect(await page.getByRole("main").innerText()).not.toMatch(/\$\d/);
  await expect(page.getByRole("link", { name: "See the app" })).toHaveAttribute("href", "/");
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe("rgb(27, 27, 27)");
  expect(await noOverflow(page)).toBe(true);
});
