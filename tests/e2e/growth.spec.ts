import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { formatGrowthBlock } from "../../src/server/growth-note";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = (p = "growth") =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

type SaWindow = Window & {
  __saLog: string[];
  __saVis: { v: string; at: number; stage: boolean; graphic: boolean; edges: number }[];
};

/**
 * Records every change of <html data-sa-theme> ("theme:app" / "theme:growth") and
 * data-sa-switching ("in" / "in-quiet" / "out", "end" when removed) from the first paint, plus
 * what the stage showed at the start of each transition. No hook in the product code.
 */
async function recordSwitches(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SaWindow;
    w.__saLog = [];
    w.__saVis = [];
    // Init scripts can run before <html> exists: watch the document and keep only <html>.
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target !== document.documentElement) continue;
        const v = document.documentElement.getAttribute(r.attributeName!);
        if (r.attributeName === "data-sa-theme") {
          w.__saLog.push(`theme:${v ?? "none"}`);
          continue;
        }
        w.__saLog.push(v ?? "end");
        if (!v) continue;
        const shown = (s: string) => !!document.querySelector(s)?.checkVisibility();
        w.__saVis.push({
          v,
          at: performance.now(),
          stage: shown("[data-sa-switch-stage]"),
          graphic: shown(".sa-switch-graphic"),
          edges: [...document.querySelectorAll(".sa-switch-edge")].filter((e) =>
            e.checkVisibility({ opacityProperty: true }),
          ).length,
        });
      }
    }).observe(document, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-sa-theme", "data-sa-switching"],
    });
  });
}

const saLog = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saLog);
const saVis = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saVis);
const resetLog = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as SaWindow;
    w.__saLog = [];
    w.__saVis = [];
  });
const count = (log: string[], v: string) => log.filter((x) => x === v).length;

/** Past load and SETTLE_MS: from here on, a scroll across the boundary plays the switch. */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForTimeout(700);
}

/** The absolute top of the Growth part: the switch boundary. */
const boundaryTop = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector('[data-sa-half="growth"]')!.getBoundingClientRect().top +
      window.scrollY,
  );

/** Puts the boundary `fraction` of the way down the screen in one scroll (a jump if far). */
const scrollBoundaryTo = (page: Page, fraction: number) =>
  page.evaluate((f) => {
    const el = document.querySelector('[data-sa-half="growth"]')!;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - f * window.innerHeight);
  }, fraction);

/** The same, in small steps (`step` of a screen a frame, a fifth by default), like scrolling. */
const stepBoundaryTo = (page: Page, fraction: number, step = 0.2) =>
  page.evaluate(
    async ([f, s]) => {
      const el = document.querySelector('[data-sa-half="growth"]')!;
      const vh = window.innerHeight;
      const goal = el.getBoundingClientRect().top + window.scrollY - f * vh;
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (let i = 0; i < 400 && Math.abs(window.scrollY - goal) > 1; i++) {
        const d = goal - window.scrollY;
        const before = window.scrollY;
        window.scrollTo(0, Math.abs(d) <= s * vh ? goal : before + Math.sign(d) * s * vh);
        await frame();
        if (window.scrollY === before) break;
      }
    },
    [fraction, step] as const,
  );

/** Back to the very top in small steps, so no line crossing is skipped. */
const stepToTop = (page: Page) =>
  page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 400 && window.scrollY > 0; i++) {
      window.scrollTo(0, Math.max(0, window.scrollY - 0.2 * window.innerHeight));
      await frame();
    }
  });

const html = (page: Page) => page.locator("html");
const growthHalf = (page: Page) => page.locator('[data-sa-half="growth"]');
const opener = (page: Page) =>
  page.getByRole("region", { name: "Squared Away Growth", exact: true });
const landed = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".sa-land > span")].map((s) => getComputedStyle(s).opacity),
  );

/** Switched and finished: Growth colours, no transition running. */
async function expectGrowth(page: Page) {
  await expect
    .poll(() => html(page).getAttribute("data-sa-theme"), { timeout: 2000 })
    .toBe("growth");
  await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/, { timeout: 2000 });
}
async function expectApp(page: Page) {
  await expect.poll(() => html(page).getAttribute("data-sa-theme"), { timeout: 2000 }).toBe("app");
  await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/, { timeout: 2000 });
}

/** Background of the first non-transparent box under each point (walking up from the hit). */
const surfacesAt = (page: Page, points: [number, number][]) =>
  page.evaluate((pts) => {
    return pts.map(([fx, fy]) => {
      let el = document.elementFromPoint(fx * window.innerWidth, fy * window.innerHeight);
      while (el) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        el = el.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    });
  }, points);

const PAPER = "rgb(247, 246, 243)";
const CHARCOAL = "rgb(27, 27, 27)";

test.describe("homepage: the way into Squared Away Growth", () => {
  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

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

    await settle(page);
    await hero.click();
    // The way in is the switch too: the show plays and the page moves to the opener under it.
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    await expect(page).toHaveURL(/\/#growth$/);
    expect(count(await saLog(page), "in")).toBe(1);
    expect(await landed(page)).toEqual(["1", "1"]);

    // The tap added a history entry, as the link would: Back returns to the top of the homepage.
    await resetLog(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Introduction" })).toBeInViewport();
    await expectApp(page);
    const back = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(back).not.toContain(v);
  });

  test("the header Growth link plays the switch on the way to the opener (desktop)", async ({
    page,
  }) => {
    test.skip(page.viewportSize()!.width < 640, "the header link shows from sm up");
    await page.goto("/");
    await settle(page);
    await page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Growth", exact: true })
      .click();
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    await expect(page).toHaveURL(/\/#growth$/);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the hero link from the keyboard keeps the native jump: instant, no show", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await page
      .getByRole("region", { name: "Introduction" })
      .getByRole("link", { name: "Want more work coming in? See Squared Away Growth" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(opener(page)).toBeInViewport();
    await expectGrowth(page);
    expect(count(await saLog(page), "in")).toBe(0);
  });

  test("after the show, a later tap on the hero link from the top is an instant jump", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await stepToTop(page);
    await expectApp(page);
    await page.waitForTimeout(300);
    await resetLog(page);
    await page
      .getByRole("region", { name: "Introduction" })
      .getByRole("link", { name: "Want more work coming in? See Squared Away Growth" })
      .click();
    await expect(opener(page)).toBeInViewport();
    await expectGrowth(page);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(0);
    expect(count(log, "in-quiet")).toBe(0);
  });

  test("a link that lands inside the band picks the right side at once", async ({ page }) => {
    // How far below the waitlist's landing spot the Growth part starts (width decides it).
    await page.goto("/");
    const gap = await page.evaluate(() => {
      document.getElementById("waitlist")!.scrollIntoView({ block: "start" });
      return document.querySelector('[data-sa-half="growth"]')!.getBoundingClientRect().top;
    });
    // A screen tall enough that, after "Get on the list", Growth's top sits at 96% of it: inside
    // the band (85–100%), below the middle line (92.5%), so the app side is right.
    const width = page.viewportSize()!.width;
    await page.setViewportSize({ width, height: Math.round(gap / 0.96) });
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Get on the list" })
      .click();
    await expect(page.getByRole("region", { name: "Join the waitlist" })).toBeInViewport();
    const at = await page.evaluate(
      () =>
        document.querySelector('[data-sa-half="growth"]')!.getBoundingClientRect().top /
        window.innerHeight,
    );
    expect(at).toBeGreaterThan(0.925);
    expect(at).toBeLessThan(1);
    await expectApp(page);
  });

  test("the chapter bar shows over the Growth chapter only", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByRole("navigation", { name: "Growth" });
    const call = bar.getByRole("link", { name: "Book a free call" });
    await expect(call).toHaveAttribute("href", "#growth-call");

    await page.getByRole("region", { name: "Pricing" }).scrollIntoViewIfNeeded();
    await expect(bar).not.toBeInViewport();

    await page.getByRole("region", { name: "Ground rules" }).scrollIntoViewIfNeeded();
    await expectGrowth(page);
    await expect(call).toBeInViewport();
    const box = (await bar.boundingBox())!;
    expect(box.y).toBeLessThan(20);
    // The bar fully covers the header: no strip of it peeks out below.
    const heights = await page.evaluate(() => ({
      header: document.querySelector("header")!.getBoundingClientRect().height,
      bar: document.querySelector("[data-growth-chapter] > div")!.getBoundingClientRect().height,
    }));
    expect(heights.bar).toBeGreaterThanOrEqual(heights.header);
    // Solid charcoal: a see-through bar would show the header through it as a third grey.
    await expect(page.locator("[data-growth-chapter] > div").first()).toHaveCSS(
      "background-color",
      CHARCOAL,
    );
    expect((await call.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("order: the app part, then the Growth part", async ({ page }) => {
    await page.goto("/");
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("main section[aria-label]")].map((s) =>
        s.getAttribute("aria-label"),
      ),
    );
    expect(names).toEqual([
      "Introduction",
      "How it works",
      "Our promise",
      "What it does",
      "Who's behind this",
      "Pricing",
      "Questions",
      "Join the waitlist",
      "Introducing Squared Away Growth",
      "Squared Away Growth",
      "What we take on",
      "How Growth works",
      "Ground rules",
      "Growth questions",
      "Book a free call",
    ]);
    const app = page.locator('[data-sa-half="app"]');
    for (const name of ["Who's behind this", "Introducing Squared Away Growth"]) {
      await expect(app.getByRole("region", { name, exact: true })).toHaveCount(1);
    }
    await expect(
      growthHalf(page).getByRole("region", { name: "Squared Away Growth", exact: true }),
    ).toHaveAttribute("id", "growth");
    await expect(page.locator("#growth")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Who does the work" })).toHaveCount(0);
  });

  test("paper all the way down to the switch", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    // Growth's top edge 10% up from the bottom: only the bar can show, and on paper.
    await stepBoundaryTo(page, 0.9);
    await page.waitForTimeout(300);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "app");
    await expect(growthHalf(page)).toHaveCSS("background-color", PAPER);
    const below = await surfacesAt(page, [
      [0.02, 0.92],
      [0.02, 0.95],
      [0.02, 0.98],
    ]);
    for (const bg of below) expect(bg).not.toBe(CHARCOAL);
    // The opener's words are still below the screen: nothing of the reveal is spoiled.
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).not.toBeInViewport();
    expect(count(await saLog(page), "in")).toBe(0);
  });

  test("scrolling Growth up into view plays the switch, then the whole site is charcoal", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    // Only the leading edge: the bottom one shows only as the cover lifts.
    expect(start.edges).toBe(1);

    // Nothing disappears before the cover is up; nothing scrolls sideways mid-sweep; the stage
    // never takes a tap.
    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(150);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(400);
      const g = document.querySelector(".sa-switch-graphic")!.getBoundingClientRect();
      const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      return {
        early,
        overflow,
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.stillPlaying).toBe(true);
    expect(during.hitOutside).toBe(true);

    await expectGrowth(page);
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("header")).toHaveCSS("background-color", CHARCOAL);
    const heading = opener(page).getByRole("heading", {
      name: "the marketing side, done for you.",
    });
    await expect(heading).toBeInViewport();
    // The switch lands on the opener: at the top, under the chapter bar.
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);

    // Islands keep their colours; app inputs keep a visible edge on the graphite card.
    await expect(page.locator('[data-sa-half="growth"] > div').first()).toHaveCSS(
      "background-color",
      CHARCOAL,
    );
    await expect(page.getByRole("region", { name: "Our promise" })).toHaveCSS(
      "background-color",
      CHARCOAL,
    );
    await expect(
      page.getByRole("region", { name: "Join the waitlist" }).getByLabel("Your name"),
    ).toHaveCSS("border-top-color", "rgb(154, 153, 148)");
    const call = page.getByRole("region", { name: "Book a free call" });
    await expect(call.locator(".sa-light")).toHaveCSS("background-color", "rgb(239, 238, 234)");
    await expect(call.getByLabel("Your name")).toHaveCSS("border-top-color", "rgb(94, 93, 89)");
  });

  test("scrolling back up wipes quietly to paper; the next way down is quiet too", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);

    await resetLog(page);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    await expect(page.locator("header")).toHaveCSS("background-color", PAPER);
    expect(await noOverflow(page)).toBe(true);
    let log = await saLog(page);
    expect(log).toContain("out");
    expect(log).not.toContain("in");
    const out = (await saVis(page)).find((x) => x.v === "out")!;
    expect(out.graphic).toBe(false);
    expect(out.edges).toBe(0);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    for (const v of await saVis(page)) {
      expect(v.graphic).toBe(false);
      expect(v.edges).toBe(0);
    }
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    let log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");

    await scrollBoundaryTo(page, 1.05);
    await expectApp(page);
    await resetLog(page);
    for (const f of [0.99, 0.87, 0.95, 0.86]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    log = await saLog(page);
    expect(log).not.toContain("in");
    expect(log).not.toContain("in-quiet");
    await expect(html(page)).toHaveAttribute("data-sa-theme", "app");
  });

  test("sitting right on the boundary plays at most once, then stays still", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.85);
    await page.waitForTimeout(2500);
    const settled = await saLog(page);
    expect(count(settled, "in")).toBeLessThanOrEqual(1);
    await page.waitForTimeout(1000);
    expect(await saLog(page)).toEqual(settled);
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.evaluate(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number }[]) w.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.waitForTimeout(200);
    const measure = () =>
      page.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        opener: document.getElementById("growth")!.getBoundingClientRect().top + window.scrollY,
        cls: (window as unknown as { __cls: number }).__cls,
      }));
    await stepBoundaryTo(page, 0.95);
    const before = { ...(await measure()), boundary: await boundaryTop(page) };
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    await expectGrowth(page);
    const after = { ...(await measure()), boundary: await boundaryTop(page) };
    expect(after).toEqual(before);
  });

  test("a fast flick from the top of the page still plays the show", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    // 0.35 of a screen a frame: more than the 15% band, so one frame can cross both lines.
    await stepBoundaryTo(page, 0.3, 0.35);
    await expectGrowth(page);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    for (const key of ["PageDown", "Space", "ArrowDown", "End"]) await page.keyboard.press(key);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    const heading = page.locator("#growth h2");
    await expect(heading).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    // After the show, scrolling works again.
    const y = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y);
  });

  test("Back during the show: an instant swap at the end, no wipe", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    // A same-page entry to go back to, made at the top of the page.
    await page.evaluate(() => window.history.pushState(null, "", "#top-of-page"));
    await stepBoundaryTo(page, 0.4);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/\/$/);
    await expectApp(page);
    await expect(page.getByRole("region", { name: "Introduction" })).toBeInViewport();
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(log.slice(log.indexOf("in"))).not.toContain("out");
    expect(log.slice(log.indexOf("in"))).not.toContain("in-quiet");
  });

  test("Tab into Growth: an instant swap, the focused link never under the cover", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    const submit = page
      .getByRole("region", { name: "Join the waitlist" })
      .getByRole("button", { name: "Join the waitlist" });
    await submit.evaluate((b) => {
      b.scrollIntoView({ block: "end" });
      (b as HTMLElement).focus({ preventScroll: true });
    });
    await page.waitForTimeout(300);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "app");
    await resetLog(page);
    await page.keyboard.press("Tab");
    const call = page
      .getByRole("navigation", { name: "Growth" })
      .getByRole("link", { name: "Book a free call" });
    await expect(call).toBeFocused();
    await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
    await page.waitForTimeout(600);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });

  test("taps during the show land on nothing", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const url = page.url();
    // The chapter bar's "Book a free call" link is right there under the cover.
    const link = await page.evaluate(() => {
      const r = document
        .querySelector('[data-growth-chapter] a[href="#growth-call"]')!
        .getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: window.innerHeight };
    });
    expect(link.y).toBeGreaterThan(0);
    expect(link.y).toBeLessThan(link.h);
    await page.mouse.click(link.x, link.y);
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height / 2);
    // Both taps happened while the cover was up.
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    expect(page.url()).toBe(url);
    await expect(page.getByRole("region", { name: "Book a free call" })).not.toBeInViewport();
    expect(
      await page.evaluate(
        () => document.activeElement === document.body || !document.activeElement,
      ),
    ).toBe(true);
    // After the show, taps work again.
    await page
      .getByRole("navigation", { name: "Growth" })
      .getByRole("link", { name: "Book a free call" })
      .click();
    await expect(page).toHaveURL(/#growth-call$/);
  });

  test("there is no switch to tap: the graphic is decoration only", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toHaveCSS("pointer-events", "none");
    await expect(stage).toBeHidden();
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("[data-sa-switch-stage]")),
      ).toBe(false);
    }
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });

  test("deep links and reloads land in Growth without a show", async ({ page }) => {
    await page.goto("/#growth-call");
    await expectGrowth(page);
    await expect(page.getByRole("region", { name: "Book a free call" })).toBeInViewport();
    await page.waitForTimeout(800);
    expect(await saLog(page)).not.toContain("in");

    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.3);
    await expectGrowth(page);
    await page.reload();
    await settle(page);
    await expectGrowth(page);
    expect(await saLog(page)).not.toContain("in");
  });

  test("leaving the homepage takes the switch with it", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);

    await resetLog(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(html(page)).toHaveAttribute("data-sa-theme", /app|growth/);
    await page.waitForTimeout(1500);
    expect(await saLog(page)).not.toContain("in");
  });
});

test.describe("homepage without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the Growth part is charcoal and fully usable; the stage never shows", async ({ page }) => {
    await page.goto("/");
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    const links = growthHalf(page).getByRole("link", { name: "Book a free call" });
    await expect(links).toHaveCount(2);
    for (const l of await links.all()) await expect(l).toBeVisible();
    const call = page.getByRole("region", { name: "Book a free call" });
    for (const label of ["Your name", /^Phone/, /^Email/, "Trade"]) {
      await expect(call.getByLabel(label)).toBeVisible();
    }
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
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
