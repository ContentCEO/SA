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
  // Check 7 P8: the signature headline, one h1 each. Check 7 P1: no raw ** anywhere.
  for (const [path, heavy, bold] of [
    ["/privacy", "privacy policy.", "I called them"],
    ["/terms", "terms of service.", "Send reply"],
  ] as const) {
    await page.goto(path);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText("the fine print,");
    await expect(h1).toContainText(heavy);
    await expect(h1.locator(".sa-headline-serif")).toHaveCount(1);
    await expect(page.getByText("Draft — not yet reviewed.")).toBeVisible();
    expect(await page.locator("main").innerText()).not.toContain("**");
    await expect(page.locator("main strong", { hasText: bold }).first()).toBeVisible();
  }
  await page.goto("/privacy");
  await expect(page.getByText(/Limited Use requirements/)).toBeVisible();

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
  // Check 33 P4: the sign-in, not-invited and goodbye pages carry a noindex tag instead of a
  // robots.txt block (a blocked page can still be listed by its address).
  for (const path of ["/signin", "/not-invited", "/goodbye"]) {
    expect(robots).not.toContain(`Disallow: ${path}`);
  }
  expect(robots).toContain("Disallow: /queue");
  expect(robots).toContain("Disallow: /api/");
  expect(robots).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const path of ["/growth", "/privacy", "/terms"]) expect(sitemap).toContain(`${path}</loc>`);
  expect(robots).toContain("Allow: /growth");

  const og = await request.get("/opengraph-image");
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toBe("image/png");
});

test("sign-in, not-invited and goodbye say noindex in the page; the sitemap is dated", async ({
  page,
  request,
}) => {
  for (const path of ["/signin", "/not-invited", "/goodbye"]) {
    await page.goto(path);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /follow/);
    await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute("content", /nofollow/);
  }
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const dates = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]!);
  expect(dates).toHaveLength(4);
  for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}/);
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
          // The skip link is screen-reader-only until it has focus (then 44px; Check 32 P12).
          const hidden =
            r.width === 0 ||
            r.height === 0 ||
            el.closest("[aria-hidden=true]") ||
            el.matches(".sr-only:not(:focus)");
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

/**
 * Check 33 P6: one walk over every public page, read from the sitemap so a new page is covered
 * without editing the test. Each rule names the failing URL. Nothing else is fetched or printed.
 */
test("every public page has its search basics", async ({ page, request, baseURL }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThanOrEqual(4);
  const problems: string[] = [];
  /**
   * Findings waiting on another group's change, one per line, each self-expiring: the test fails
   * again when the finding is gone and the line isn't deleted. None today (the /growth
   * description entry went at the wave 3 merge A: Growth site step 12 made it 155 characters).
   */
  const waitingOn: Record<string, RegExp> = {};
  const hit = new Set<string>();
  const fail = (url: string, rule: string) => {
    const path = new URL(url).pathname;
    if (waitingOn[path]?.test(rule)) hit.add(path);
    else problems.push(`${url}: ${rule}`);
  };

  for (const url of urls) {
    const entry = new URL(url);
    const res = await page.goto(new URL(entry.pathname, baseURL).toString());
    if (res?.status() !== 200) fail(url, `status ${res?.status()}, not 200`);

    const h1s = await page.locator("h1").count();
    if (h1s !== 1) fail(url, `${h1s} h1 elements, not exactly one`);

    const title = await page.title();
    if (title.length < 10 || title.length > 70) fail(url, `title is ${title.length} characters`);

    const description =
      (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    if (description.length < 50 || description.length > 160) {
      fail(url, `meta description is ${description.length} characters (50 to 160)`);
    }

    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    if (!canonical) fail(url, "no rel=canonical");
    else if (new URL(canonical, baseURL).origin !== entry.origin) {
      fail(url, "canonical is on another origin than the sitemap entry");
    }

    const ogImage = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    if (!ogImage) fail(url, "no og:image");
    else {
      const img = await request.get(
        new URL(new URL(ogImage, baseURL).pathname, baseURL).toString(),
      );
      if (img.status() !== 200) fail(url, `og:image answered ${img.status()}`);
      if (!img.headers()["content-type"]?.startsWith("image/png")) {
        fail(url, `og:image content-type is ${img.headers()["content-type"]}`);
      }
    }

    const robots = await page.locator('meta[name="robots"]').all();
    for (const r of robots) {
      if (/noindex/i.test((await r.getAttribute("content")) ?? ""))
        fail(url, "meta robots noindex");
    }

    const missingAlt = await page.evaluate(
      () => [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
    );
    if (missingAlt) fail(url, `${missingAlt} <img> without alt`);
  }
  expect(problems).toEqual([]);
  // An entry nobody needs any more must go (else it would hide a new finding later).
  expect([...Object.keys(waitingOn)].filter((p) => !hit.has(p))).toEqual([]);
});

test("an address that doesn't exist: a plain 404 with a way home", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("nothing here, page not found.");
  await page.getByRole("link", { name: "Go to the homepage" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("/growth has one Service block for search engines and its own title (Check 33 P2)", async ({
  page,
}) => {
  await page.goto("/growth");
  await expect(page).toHaveTitle("Contractor marketing, done for you · Squared Away Growth");
  const blocks = page.locator('script[type="application/ld+json"]');
  await expect(blocks).toHaveCount(1);
  const ld = JSON.parse((await blocks.textContent()) ?? "{}") as { "@type": string };
  expect(ld["@type"]).toBe("Service");
});
