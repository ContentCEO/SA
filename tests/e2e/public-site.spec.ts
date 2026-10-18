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

test("fonts are our own: Inter Tight and Instrument Serif load from this site, never Google", async ({
  page,
  baseURL,
}) => {
  const google: string[] = [];
  const fontFiles: string[] = [];
  page.on("request", (r) => {
    if (/^https?:\/\/fonts\.(googleapis|gstatic)\.com\//.test(r.url())) google.push(r.url());
  });
  page.on("response", (r) => {
    if (/\.(woff2?|ttf|otf)(\?|$)/.test(r.url())) fontFiles.push(`${r.status()} ${r.url()}`);
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // next/font/local names each family after its variable in layout.tsx (interTight,
  // instrumentSerif); what matters is that the stack the theme uses starts with a loaded face.
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const first = (el: Element | null) =>
      el ? getComputedStyle(el).fontFamily.split(",")[0]! : "(missing)";
    return {
      sans: first(document.querySelector(".sa-headline-heavy")),
      body: first(document.body),
      serif: first(document.querySelector(".sa-headline-serif")),
      faces: [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
    };
  });
  const sans = unquote(fonts.sans);
  const serif = unquote(fonts.serif);
  expect(sans).toMatch(/^inter\s*tight$/i);
  expect(unquote(fonts.body)).toBe(sans);
  expect(serif).toMatch(/^instrument\s*serif$/i);
  // Only our two families: the "… Fallback" faces point at local Arial / Times New Roman, which
  // a Linux runner may not have.
  const ours = fonts.faces.filter((f) => [sans, serif].includes(unquote(f.family)));
  const loaded = ours.filter((f) => f.status === "loaded").map((f) => unquote(f.family));
  expect(loaded).toContain(sans);
  expect(loaded).toContain(serif);
  expect(ours.filter((f) => f.status === "error")).toEqual([]);

  expect(google).toEqual([]);
  expect(fontFiles.length).toBeGreaterThan(0);
  const origin = new URL(baseURL!).origin;
  for (const file of fontFiles) expect(file).toMatch(`200 ${origin}/_next/static/media/`);
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
  for (const path of ["/api/", "/queue", "/settings", "/money", "/record"]) {
    expect(robots).toContain(`Disallow: ${path}`);
  }
  // Check 26 P9: /admin isn't named (its pages say noindex instead).
  expect(robots).not.toContain("/admin");
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
    /^AI email help for contractors/,
  );
  await expect(page).toHaveTitle("Squared Away — AI email help for contractors");
  // Search engines' structured data: the real prices, no ratings.
  const ld = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? "[]",
  ) as { "@type": string; offers?: { price: string }[] }[];
  expect(ld.map((x) => x["@type"])).toEqual(["Organization", "SoftwareApplication"]);
  expect(ld[1]!.offers!.map((o) => o.price).sort()).toEqual([
    "199.00",
    "299.00",
    "499.00",
    "99.00",
  ]);
  // The photo spot is empty until Davi's photo exists: no placeholder box.
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  const call = page
    .getByRole("region", { name: "Join the waitlist" })
    .getByRole("link", { name: /^Call 978-201-9763$/ });
  await expect(call).toHaveAttribute("href", "tel:+19782019763");
  expect((await call.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Check 6 P4: the queue picture shows Send reply; the trial rule is its caption.
  await expect(page.locator("figure").first()).toContainText("Send reply");
  await expect(page.getByRole("region", { name: "Who's behind this" })).toContainText(
    "A&C Construction",
  );
});

test("/growth has its own share card, not the app's", async ({ page, request }) => {
  await page.goto("/");
  const homeOg = await page.locator('meta[property="og:image"]').getAttribute("content");
  await page.goto("/growth");
  const og = page.locator('meta[property="og:image"]');
  await expect(og).toHaveAttribute("content", /\/growth\/opengraph-image/);
  expect(await og.getAttribute("content")).not.toBe(homeOg);
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    /^Squared Away Growth/,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    /\/growth\/twitter-image/,
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

test("footer: the phone number is a 44px call link, and public pages link to Growth", async ({
  page,
}) => {
  for (const path of ["/", "/privacy", "/signin"]) {
    await page.goto(path);
    const footer = page.locator("footer");
    const tel = footer.getByRole("link", { name: "978-201-9763" });
    await expect(tel).toHaveAttribute("href", "tel:+19782019763");
    expect((await tel.boundingBox())!.height, path).toBeGreaterThanOrEqual(44);
    const growth = footer.getByRole("link", { name: "Squared Away Growth" });
    await expect(growth).toHaveAttribute("href", "/growth");
    expect((await growth.boundingBox())!.height, path).toBeGreaterThanOrEqual(44);
  }
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Squared Away Growth" }).getByRole("link", {
      name: /See everything Growth does/,
    }),
  ).toHaveAttribute("href", "/growth");
});

test("an address that doesn't exist: a plain 404 with a way home", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("nothing here, page not found.");
  await page.getByRole("link", { name: "Go to the homepage" }).click();
  await expect(page).toHaveURL(/\/$/);
});
