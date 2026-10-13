import { expect, test, type Page } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/** Collect console errors (including CSP violations) and page crashes while visiting. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("security headers on the homepage", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
});

test("the CSP breaks nothing: public pages and a signed-in screen load with no console errors", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  for (const path of ["/", "/growth", "/privacy", "/terms", "/signin"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // The FAQ still opens.
  await page.goto("/");
  const faq = page.getByText("Does it work with Outlook?");
  await faq.click();
  await expect(page.getByText("Gmail only for now, including Google Workspace.")).toBeVisible();

  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});

test("privacy and terms: drafts are labelled, and every page links to them", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByText("Draft — not yet reviewed.")).toBeVisible();
  await expect(page.getByText(/Limited Use requirements/)).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await expect(page.getByText("Draft — not yet reviewed.")).toBeVisible();

  for (const path of ["/", "/signin"]) {
    await page.goto(path);
    const legal = page.getByRole("navigation", { name: "Legal" });
    await expect(legal.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    await expect(legal.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  }
});

test("robots.txt, sitemap.xml and the share image", async ({ request }) => {
  const robots = await (await request.get("/robots.txt")).text();
  for (const path of ["/admin", "/api/", "/queue", "/settings"]) {
    expect(robots).toContain(`Disallow: ${path}`);
  }
  expect(robots).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const path of ["/growth", "/privacy", "/terms"]) expect(sitemap).toContain(`${path}</loc>`);
  expect(robots).toContain("Allow: /growth");

  const og = await request.get("/opengraph-image");
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toBe("image/png");
});

test("homepage: share card tags, the call button and the trial clock in the phone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /opengraph-image/,
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /^Built for carpenters/,
  );
  const call = page
    .getByRole("region", { name: "Join the waitlist" })
    .getByRole("link", { name: /^Call 978-201-9763$/ });
  await expect(call).toHaveAttribute("href", "tel:+19782019763");
  expect((await call.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("Day 1 of 3 · 2 days left")).toBeAttached();
  await expect(page.getByRole("region", { name: "Who's behind this" })).toContainText(
    "A&C Construction",
  );
});

test("/growth has the share card too (its own openGraph would otherwise drop it)", async ({
  page,
  request,
}) => {
  await page.goto("/growth");
  const og = page.locator('meta[property="og:image"]');
  await expect(og).toHaveAttribute("content", /\/opengraph-image$/);
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    /\/opengraph-image$/,
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  const image = await request.get(new URL((await og.getAttribute("content"))!).pathname);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
});

test("tap targets: every link and button on the homepage and /growth is at least 44px tall", async ({
  page,
}) => {
  const check = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("a, button, summary, select, input:not([type=hidden])")]
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const hidden = r.width === 0 || r.height === 0 || el.closest("[aria-hidden=true]");
          return !hidden && r.height < 44;
        })
        .map((el) => `${el.tagName} ${(el.textContent ?? "").trim().slice(0, 40)}`),
    );
  for (const path of ["/", "/growth"]) {
    await page.goto(path);
    expect(await check()).toEqual([]);
  }
  // The homepage again after the switch to Growth (the decorative stage is aria-hidden).
  await page.goto("/");
  await page.evaluate(() => {
    const el = document.querySelector('[data-sa-half="growth"]')!;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 0.4 * window.innerHeight);
  });
  await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "growth");
  await expect(page.locator("html")).not.toHaveAttribute("data-sa-switching", /.*/);
  expect(await check()).toEqual([]);
});
