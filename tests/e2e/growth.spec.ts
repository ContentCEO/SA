import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { formatGrowthBlock } from "../../src/server/growth-note";
import { BL_THEME_AT_MS } from "../../src/components/marketing/growth/looks/blinds-rules";
import { BW_THEME_AT_MS } from "../../src/components/marketing/growth/looks/big-words-rules";
import { CURTAIN_THEME_AT_MS } from "../../src/components/marketing/growth/looks/curtains-rules";
import { LIGHT_THEME_AT_MS } from "../../src/components/marketing/growth/looks/light-switch-rules";
import { TIDE_THEME_AT_MS } from "../../src/components/marketing/growth/looks/tide-rules";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = (p = "growth") =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

type SaWindow = Window & {
  __saLog: string[];
  __saVis: {
    v: string;
    at: number;
    stage: boolean;
    graphic: boolean;
    edges: number;
    /** Look 1 (light switch): the dark circle's radius in px, and the quiet cover's state. */
    dark: number | null;
    cover: { anims: string[]; bg: string } | null;
    lift: string | null;
    /** Look 2 (curtains): the animations on the two halves, and the left half's colour. */
    halves: { anims: string[]; bg: string } | null;
    /** Look 3 (tide): the animations on the water, and its colour. */
    water: { anims: string[]; bg: string } | null;
    /** Look 4 (big words): the animations on the bands, and the middle band's colour. */
    bands: { anims: string[]; bg: string } | null;
    /** Look 5 (blinds): the animations on the slats and the blind, and the first slat's colour. */
    slats: { anims: string[]; lift: string[]; bg: string } | null;
  }[];
  /** Look 1: what was on screen when the theme swapped during the full show. */
  __saSwap: {
    dt: number;
    r: number | null;
    far: number;
    from: string;
    to: string;
  } | null;
  /** Look 2: where the curtains were when the theme swapped during the full show. */
  __saSwapCu: {
    dt: number;
    left: { left: number; right: number };
    right: { left: number; right: number };
    width: number;
    /** The chip on "One-on-one" (the look's one word). */
    to: string;
  } | null;
  /** Look 3: where the tide was when the theme swapped during the full show. */
  __saSwapTd: {
    dt: number;
    top: number;
    bottom: number;
    crestBottom: number;
    vh: number;
    from: string;
    to: string;
  } | null;
  /** Look 4: where the bands were when the theme swapped during the full show. */
  __saSwapBw: {
    dt: number;
    bands: { left: number; right: number; top: number; bottom: number }[];
    vw: number;
    vh: number;
    from: string;
    to: string;
  } | null;
  /** Look 5: where the blind and its slats were when the theme swapped during the full show. */
  __saSwapBl: {
    dt: number;
    lift: { top: number; bottom: number };
    slats: { left: number; right: number; top: number; bottom: number }[];
    back: string;
    vw: number;
    vh: number;
    from: string;
    to: string;
  } | null;
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
    w.__saSwap = null;
    w.__saSwapCu = null;
    w.__saSwapTd = null;
    w.__saSwapBw = null;
    w.__saSwapBl = null;
    let inAt = 0;
    // Look 1's dark is a disc scaled by transform: its box on screen is its size.
    const radius = () => {
      const d = document.querySelector(".sa-ls-dark");
      return d ? d.getBoundingClientRect().width / 2 : null;
    };
    // Init scripts can run before <html> exists: watch the document and keep only <html>.
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target !== document.documentElement) continue;
        const v = document.documentElement.getAttribute(r.attributeName!);
        if (r.attributeName === "data-sa-theme") {
          w.__saLog.push(`theme:${v ?? "none"}`);
          const root = document.documentElement;
          if (
            v === "growth" &&
            root.getAttribute("data-sa-switching") === "in" &&
            root.getAttribute("data-sa-look") === "1"
          ) {
            const c = document.querySelector(".sa-ls-center")!.getBoundingClientRect();
            const cy = c.top + c.height / 2;
            const chip = (side: string) =>
              getComputedStyle(
                document.querySelector(`.sa-ls-label[data-label="${side}"] .sa-ls-chip`)!,
              ).opacity;
            w.__saSwap = {
              dt: performance.now() - inAt,
              r: radius(),
              far: Math.hypot(window.innerWidth / 2, Math.max(cy, window.innerHeight - cy)),
              from: chip("from"),
              to: chip("to"),
            };
          }
          if (
            v === "growth" &&
            root.getAttribute("data-sa-switching") === "in" &&
            root.getAttribute("data-sa-look") === "2"
          ) {
            const rect = (side: string) => {
              const box = document
                .querySelector(`.sa-cu-half[data-side="${side}"]`)!
                .getBoundingClientRect();
              return { left: box.left, right: box.right };
            };
            // The left half's copy of the word (each half has one; they flip together).
            w.__saSwapCu = {
              dt: performance.now() - inAt,
              left: rect("left"),
              right: rect("right"),
              width: document.querySelector("[data-sa-switch-stage]")!.getBoundingClientRect()
                .width,
              to: getComputedStyle(document.querySelector(".sa-cu-chip")!).opacity,
            };
          }
          if (
            v === "growth" &&
            root.getAttribute("data-sa-switching") === "in" &&
            root.getAttribute("data-sa-look") === "3"
          ) {
            const water = document.querySelector(".sa-td-water")!.getBoundingClientRect();
            const chip = (side: string) =>
              getComputedStyle(
                document.querySelector(`.sa-td-label[data-label="${side}"] .sa-td-chip`)!,
              ).opacity;
            w.__saSwapTd = {
              dt: performance.now() - inAt,
              top: water.top,
              bottom: water.bottom,
              crestBottom: document.querySelector(".sa-td-crest")!.getBoundingClientRect().bottom,
              vh: window.innerHeight,
              from: chip("from"),
              to: chip("to"),
            };
          }
          if (
            v === "growth" &&
            root.getAttribute("data-sa-switching") === "in" &&
            root.getAttribute("data-sa-look") === "4"
          ) {
            const chip = (side: string) =>
              getComputedStyle(
                document.querySelector(`.sa-bw-word[data-word="${side}"] .sa-bw-chip`)!,
              ).opacity;
            w.__saSwapBw = {
              dt: performance.now() - inAt,
              bands: [...document.querySelectorAll(".sa-bw-band")].map((b) => {
                const r = b.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              }),
              vw: window.innerWidth,
              vh: window.innerHeight,
              from: chip("from"),
              to: chip("to"),
            };
          }
          if (
            v === "growth" &&
            root.getAttribute("data-sa-switching") === "in" &&
            root.getAttribute("data-sa-look") === "5"
          ) {
            // The first slat's copy of the title (every slat has one; they flip together).
            const chip = (side: string) =>
              getComputedStyle(
                document.querySelector(`.sa-bl-label[data-label="${side}"] .sa-bl-chip`)!,
              ).opacity;
            const lift = document.querySelector(".sa-bl-blind")!.getBoundingClientRect();
            w.__saSwapBl = {
              dt: performance.now() - inAt,
              lift: { top: lift.top, bottom: lift.bottom },
              slats: [...document.querySelectorAll(".sa-bl-slat")].map((b) => {
                const r = b.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              }),
              back: getComputedStyle(document.querySelector(".sa-bl-back")!).opacity,
              vw: window.innerWidth,
              vh: window.innerHeight,
              from: chip("from"),
              to: chip("to"),
            };
          }
          continue;
        }
        w.__saLog.push(v ?? "end");
        if (!v) continue;
        if (v === "in") inAt = performance.now();
        const cover = document.querySelector(".sa-ls-cover");
        const lift = document.querySelector(".sa-ls-show");
        const halves = [...document.querySelectorAll(".sa-cu-half")];
        const water = document.querySelector(".sa-td-water");
        const bands = [...document.querySelectorAll(".sa-bw-band")];
        const slats = [...document.querySelectorAll(".sa-bl-slat")];
        const blind = document.querySelector(".sa-bl-blind");
        const shown = (s: string) => !!document.querySelector(s)?.checkVisibility();
        w.__saVis.push({
          v,
          at: performance.now(),
          stage: shown("[data-sa-switch-stage]"),
          graphic: shown("[data-sa-switch-graphic]"),
          edges: [...document.querySelectorAll(".sa-switch-edge, .sa-cu-edge")].filter((e) =>
            e.checkVisibility({ opacityProperty: true }),
          ).length,
          dark: radius(),
          cover: cover
            ? {
                anims: cover.getAnimations().map((a) => (a as CSSAnimation).animationName),
                bg: getComputedStyle(cover).backgroundColor,
              }
            : null,
          lift: lift ? getComputedStyle(lift).display : null,
          halves: halves.length
            ? {
                anims: halves.flatMap((h) =>
                  h.getAnimations().map((a) => (a as CSSAnimation).animationName),
                ),
                bg: getComputedStyle(halves[0]).backgroundColor,
              }
            : null,
          water: water
            ? {
                anims: water.getAnimations().map((a) => (a as CSSAnimation).animationName),
                bg: getComputedStyle(water).backgroundColor,
              }
            : null,
          bands: bands.length
            ? {
                anims: bands.flatMap((b) =>
                  b.getAnimations().map((a) => (a as CSSAnimation).animationName),
                ),
                bg: getComputedStyle(bands[2]).backgroundColor,
              }
            : null,
          slats: slats.length
            ? {
                anims: slats.flatMap((b) =>
                  b.getAnimations().map((a) => (a as CSSAnimation).animationName),
                ),
                lift: blind
                  ? blind.getAnimations().map((a) => (a as CSSAnimation).animationName)
                  : [],
                bg: getComputedStyle(slats[0]).backgroundColor,
              }
            : null,
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
    w.__saSwap = null;
    w.__saSwapCu = null;
    w.__saSwapTd = null;
    w.__saSwapBw = null;
    w.__saSwapBl = null;
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
const OFFWHITE = "rgb(239, 238, 234)";

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

/*
 * TEMPORARY preview look 1, "Light switch" (`/?look=1`): the same switch (scrolling decides,
 * hysteresis, held input, instant for reduced motion), a different picture. Remove with the
 * `?look=` chooser once a look is picked.
 */
test.describe("homepage switch, look 1: light switch", () => {
  const LOOK_1 = "/?look=1";
  const swap = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwap);

  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("scrolling past the boundary flips the switch, then the site is charcoal on the opener", async ({
    page,
  }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "1");
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "1");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    // No leading edge in this look: the dark's own rim only shows as it drains at the end.
    expect(start.edges).toBe(0);
    expect(start.cover?.anims).toEqual([]);

    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(250);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(400);
      const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      return {
        early,
        overflow,
        // The plate fits the screen: no part of it is cut off at 375px or on a desktop.
        plateInside:
          g.left >= 0 && g.right <= window.innerWidth && g.top >= 0 && g.bottom <= innerHeight,
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.plateInside).toBe(true);
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
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the plate pops before the dark arrives", async ({ page }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.graphic).toBe(true);
    expect(start.dark).toBe(0);
    const early = await page.evaluate(async (at) => {
      await new Promise((r) => setTimeout(r, Math.max(0, at + 200 - performance.now())));
      const chip = (side: string) =>
        getComputedStyle(document.querySelector(`.sa-ls-label[data-label="${side}"] .sa-ls-chip`)!)
          .opacity;
      return {
        theme: document.documentElement.getAttribute("data-sa-theme"),
        dark: document.querySelector(".sa-ls-dark")!.getBoundingClientRect().width,
        from: chip("from"),
        to: chip("to"),
      };
    }, start.at);
    expect(early.theme).toBe("app");
    expect(early.dark).toBe(0);
    // "The app" is still the inverted (active) label before the click.
    expect(early).toMatchObject({ from: "1", to: "0" });
    for (const bg of await surfacesAt(page, [
      [0.02, 0.02],
      [0.98, 0.02],
    ]))
      expect(bg).toBe(PAPER);
    await expectGrowth(page);
  });

  test("the dark covers the whole screen before the swap, with One-on-one lit", async ({
    page,
  }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    const s = (await swap(page))!;
    expect(s).not.toBeNull();
    expect(s.r).not.toBeNull();
    expect(s.r!).toBeGreaterThanOrEqual(s.far);
    expect(s.dt).toBeGreaterThanOrEqual(560);
    expect(s.to).toBe("1");
    expect(s.from).toBe("0");
  });

  test("scrolling up drains the dark into the middle; the next way down is quiet", async ({
    page,
  }) => {
    await page.goto(LOOK_1);
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
    expect(out.cover?.anims).toContain("sa-ls-drain");
    expect(out.cover?.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);
    expect(out.lift).toBe("none");
    expect(out.edges).toBe(0);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    expect(quiet.cover?.anims).toContain("sa-ls-drain");
    expect(quiet.cover?.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(quiet.lift).toBe("none");
  });

  test("at the end the plate sinks back into the wall and the dark drains into it", async ({
    page,
  }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const end = await page.evaluate(async (at) => {
      const look = () => {
        const d = document.querySelector(".sa-ls-dark")!.getBoundingClientRect();
        const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
        return {
          r: d.width / 2,
          far: Math.hypot(window.innerWidth / 2, window.innerHeight / 2),
          plate: g.width,
          // The rim is the dark's own border: off-white only while it drains.
          rim: getComputedStyle(document.querySelector(".sa-ls-dark")!).borderTopColor,
        };
      };
      await new Promise((r) => setTimeout(r, Math.max(0, at + 1000 - performance.now())));
      const held = look();
      // Every frame from the hold to cleanup (the CSS clock can trail the page's timers a little).
      const frames: ReturnType<typeof look>[] = [];
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (document.documentElement.getAttribute("data-sa-switching") !== "in") return resolve();
          frames.push(look());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { held, frames };
    }, start.at);
    // Held: the dark past every corner, its rim unseen (charcoal on charcoal).
    expect(end.held.r).toBeGreaterThanOrEqual(end.held.far);
    expect(end.held.rim).toBe(CHARCOAL);
    // Going: the dark drains inside the screen with its rim showing, and the plate sinks.
    expect(end.frames.some((f) => f.rim === OFFWHITE && f.r < f.far * 0.6)).toBe(true);
    // Only the two tones: never a colour between them.
    for (const f of end.frames) expect([CHARCOAL, OFFWHITE]).toContain(f.rim);
    // The rim only shows once the dark has started to drain.
    for (const f of end.frames) if (f.rim === OFFWHITE) expect(f.r).toBeLessThanOrEqual(end.held.r);
    expect(Math.min(...end.frames.map((f) => f.plate))).toBeLessThan(end.held.plate * 0.5);
    await expectGrowth(page);
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto(LOOK_1);
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

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    await expect(page.locator("#growth h2")).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("there is no switch to tap: the plate is decoration only", async ({ page }) => {
    await page.goto(LOOK_1);
    await settle(page);
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "1");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toBeHidden();
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOOK_1);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "1");
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });
});

/*
 * TEMPORARY preview look 2, "Curtains" (`/?look=2`): the same switch (scrolling decides,
 * hysteresis, held input, instant for reduced motion), a different picture. Remove with the
 * `?look=` chooser once a look is picked.
 */
test.describe("homepage switch, look 2: curtains", () => {
  const LOOK_2 = "/?look=2";
  const swapCu = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwapCu);

  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("scrolling past the boundary draws the curtains, then the site is charcoal on the opener", async ({
    page,
  }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "2");
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "2");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    // Each curtain's leading edge.
    expect(start.edges).toBe(2);
    expect(start.halves?.anims).toEqual(
      expect.arrayContaining(["sa-cu-close-left", "sa-cu-close-right"]),
    );
    expect(start.halves?.bg).toBe(CHARCOAL);

    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(250);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(450);
      const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(window.innerWidth / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      const edges = [...document.querySelectorAll(".sa-cu-edge")].filter((e) =>
        e.checkVisibility({ opacityProperty: true }),
      ).length;
      return {
        early,
        overflow,
        // The title fits the screen, top to bottom.
        titleInside: g.top >= 0 && g.bottom <= window.innerHeight,
        edges,
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.titleInside).toBe(true);
    // Shut: the leading edges are off.
    expect(during.edges).toBe(0);
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
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the curtains are shut across the whole screen before the swap", async ({ page }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    const s = (await swapCu(page))!;
    expect(s).not.toBeNull();
    expect(s.dt).toBeGreaterThanOrEqual(360);
    expect(s.left.left).toBeLessThanOrEqual(0.5);
    expect(s.right.right).toBeGreaterThanOrEqual(s.width - 0.5);
    // They meet: no gap at the seam.
    expect(s.right.left - s.left.right).toBeLessThanOrEqual(0.5);
    // "One-on-one" isn't inverted yet at the swap.
    expect(s.to).toBe("0");
  });

  test("while shut, One-on-one is one huge poster stack, and it inverts", async ({ page }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const held = await page.evaluate(async (at) => {
      await new Promise((r) => setTimeout(r, Math.max(0, at + 800 - performance.now())));
      // Both halves' copies of the word, as laid out (their own box, not each half's clip).
      const labels = [...document.querySelectorAll(".sa-cu-label")].map((l) => {
        const r = l.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      return {
        switching: document.documentElement.getAttribute("data-sa-switching"),
        theme: document.documentElement.getAttribute("data-sa-theme"),
        to: [...document.querySelectorAll(".sa-cu-chip")].map((c) => getComputedStyle(c).opacity),
        labels,
        vw: window.innerWidth,
        vh: window.innerHeight,
        serif: document.querySelectorAll(".sa-cu-half .sa-headline-serif").length,
        lines: [
          ...document.querySelectorAll('.sa-cu-half[data-side="left"] .sa-cu-stack .sa-cu-line'),
        ].map((l) => l.textContent),
      };
    }, start.at);
    expect(held.switching).toBe("in");
    expect(held.theme).toBe("growth");
    // Both halves of the word invert together.
    expect(held.to).toEqual(["1", "1"]);
    // No serif line: one heavy word stacked a part per line, big, inside the screen with the 16px
    // gutter, and the two copies line up across the seam.
    expect(held.serif).toBe(0);
    expect(held.lines).toEqual(["One-", "on-", "one"]);
    expect(held.labels).toHaveLength(2);
    const [a, b] = held.labels;
    expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(0.5);
    expect(a.left).toBeGreaterThanOrEqual(15.5);
    expect(a.right).toBeLessThanOrEqual(held.vw - 15.5);
    expect(a.left).toBeLessThan(held.vw / 2);
    expect(a.right).toBeGreaterThan(held.vw / 2);
    expect((a.bottom - a.top) / held.vh).toBeGreaterThan(0.35);
    expect(a.top).toBeGreaterThanOrEqual(0);
    expect(a.bottom).toBeLessThanOrEqual(held.vh);
    if (held.vw < 500) expect((a.right - a.left) / held.vw).toBeGreaterThan(0.6);
    for (const bg of await surfacesAt(page, [
      [0.02, 0.02],
      [0.98, 0.98],
      [0.5, 0.02],
    ]))
      expect(bg).toBe(CHARCOAL);
    await expectGrowth(page);
  });

  test("scrolling up opens charcoal curtains onto paper; the next way down is quiet", async ({
    page,
  }) => {
    await page.goto(LOOK_2);
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
    expect(out.halves?.anims).toEqual(["sa-cu-open-left", "sa-cu-open-right"]);
    expect(out.halves?.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);
    expect(out.edges).toBe(0);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    expect(quiet.halves?.anims).toEqual(["sa-cu-open-left", "sa-cu-open-right"]);
    expect(quiet.halves?.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(quiet.edges).toBe(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto(LOOK_2);
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

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    await expect(page.locator("#growth h2")).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("there is no switch to tap: the curtains are decoration only", async ({ page }) => {
    await page.goto(LOOK_2);
    await settle(page);
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "2");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toBeHidden();
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOOK_2);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "2");
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });
});

/*
 * TEMPORARY preview look 3, "Tide" (`/?look=3`): the same switch (scrolling decides, hysteresis,
 * held input, instant for reduced motion), a different picture. Runs at 375px (mobile project)
 * and on desktop. Remove with the `?look=` chooser once a look is picked.
 */
test.describe("homepage switch, look 3: tide", () => {
  const LOOK_3 = "/?look=3";
  const swapTd = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwapTd);

  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("scrolling past the boundary brings the tide in, then the site is charcoal on the opener", async ({
    page,
  }) => {
    await page.goto(LOOK_3);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "3");
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "3");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    expect(start.water?.anims).toEqual(expect.arrayContaining(["sa-td-in", "sa-td-out"]));
    expect(start.water?.bg).toBe(CHARCOAL);

    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(250);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(900);
      const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(window.innerWidth / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      const chip = (side: string) =>
        getComputedStyle(document.querySelector(`.sa-td-label[data-label="${side}"] .sa-td-chip`)!)
          .opacity;
      const label = (side: string) => document.querySelector(`.sa-td-label[data-label="${side}"]`)!;
      const to = label("to").getBoundingClientRect();
      const water = document.querySelector(".sa-td-water")!.getBoundingClientRect();
      return {
        early,
        overflow: overflow || doc.scrollWidth > doc.clientWidth,
        // The title fits the screen, side to side and top to bottom.
        titleInside:
          g.left >= 0 && g.right <= window.innerWidth && g.top >= 0 && g.bottom <= innerHeight,
        // One line: only "One-on-one" shows now, big, inside the 16px gutter, riding high on
        // the water (in its top fifth).
        fromShown: getComputedStyle(label("from")).opacity,
        toShown: getComputedStyle(label("to")).opacity,
        toInGutter: to.left >= 15.5 && to.right <= window.innerWidth - 15.5,
        toWidth: to.width / window.innerWidth,
        toHigh: to.top - water.top < window.innerHeight * 0.2,
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
        from: chip("from"),
        to: chip("to"),
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.titleInside).toBe(true);
    expect(during.stillPlaying).toBe(true);
    expect(during.hitOutside).toBe(true);
    // Held: "One-on-one" is the inverted (active) label, alone on its line, riding high.
    expect(during).toMatchObject({ from: "0", to: "1", fromShown: "0", toShown: "1" });
    expect(during.toInGutter).toBe(true);
    expect(during.toWidth).toBeGreaterThan(0.4);
    expect(during.toHigh).toBe(true);

    await expectGrowth(page);
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("header")).toHaveCSS("background-color", CHARCOAL);
    const heading = opener(page).getByRole("heading", {
      name: "the marketing side, done for you.",
    });
    await expect(heading).toBeInViewport();
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the tide comes in from the bottom and covers the whole screen before the swap", async ({
    page,
  }) => {
    await page.goto(LOOK_3);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const early = await page.evaluate(async (at) => {
      await new Promise((r) => setTimeout(r, Math.max(0, at + 150 - performance.now())));
      const w = document.querySelector(".sa-td-water")!.getBoundingClientRect();
      return {
        theme: document.documentElement.getAttribute("data-sa-theme"),
        top: w.top / window.innerHeight,
      };
    }, start.at);
    // On its way in: part of the screen, from the bottom, before the theme has swapped.
    expect(early.theme).toBe("app");
    expect(early.top).toBeGreaterThan(0.05);
    expect(early.top).toBeLessThan(1);
    for (const bg of await surfacesAt(page, [
      [0.02, 0.02],
      [0.98, 0.02],
    ]))
      expect(bg).toBe(PAPER);

    await expectGrowth(page);
    const s = (await swapTd(page))!;
    expect(s).not.toBeNull();
    expect(s.dt).toBeGreaterThanOrEqual(520);
    expect(s.top).toBeLessThanOrEqual(0.5);
    expect(s.bottom).toBeGreaterThanOrEqual(s.vh - 0.5);
    // The crest is above the screen: nothing scalloped shows at the swap.
    expect(s.crestBottom).toBeLessThanOrEqual(0.5);
    // "The app" is still the inverted (active) label at the swap.
    expect(s).toMatchObject({ from: "1", to: "0" });
  });

  test("scrolling up, a charcoal tide goes out onto paper; the next way down recedes up", async ({
    page,
  }) => {
    await page.goto(LOOK_3);
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
    expect(out.water?.anims).toEqual(["sa-td-out"]);
    expect(out.water?.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    // Going down, the paper tide recedes up, with the scroll.
    expect(quiet.water?.anims).toEqual(["sa-td-recede-up"]);
    expect(quiet.water?.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(await noOverflow(page)).toBe(true);
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto(LOOK_3);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto(LOOK_3);
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

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto(LOOK_3);
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    await expect(page.locator("#growth h2")).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("there is no switch to tap: the tide is decoration only", async ({ page }) => {
    await page.goto(LOOK_3);
    await settle(page);
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "3");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toBeHidden();
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOOK_3);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "3");
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });
});

/*
 * TEMPORARY preview look 4, "Big words" (`/?look=4`): the same switch (scrolling decides,
 * hysteresis, held input, instant for reduced motion), a different picture. Runs at 375px (mobile
 * project) and on desktop. Remove with the `?look=` chooser once a look is picked.
 */
test.describe("homepage switch, look 4: big words", () => {
  const LOOK_4 = "/?look=4";
  const swapBw = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwapBw);

  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("scrolling past the boundary slams the bands in, then the site is charcoal on the opener", async ({
    page,
  }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "4");
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "4");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    // No edges: the bands come in and go back out sideways.
    expect(start.edges).toBe(0);
    expect(start.bands?.anims).toEqual(
      expect.arrayContaining([
        "sa-bw-in-left",
        "sa-bw-in-right",
        "sa-bw-out-left",
        "sa-bw-out-right",
      ]),
    );
    // Each band comes in and, at the end, flies back out.
    expect(start.bands?.anims).toHaveLength(10);
    expect(start.bands?.bg).toBe(CHARCOAL);

    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(250);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(900);
      const word = document
        .querySelector('.sa-bw-word[data-word="to"] .sa-bw-label')!
        .getBoundingClientRect();
      const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(window.innerWidth / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      const chip = (side: string) =>
        getComputedStyle(document.querySelector(`.sa-bw-word[data-word="${side}"] .sa-bw-chip`)!)
          .opacity;
      return {
        early,
        overflow: overflow || doc.scrollWidth > doc.clientWidth,
        // "One-on-one" is big, and still fits the screen side to side and inside its band.
        wordInside:
          word.left >= 15.5 &&
          word.right <= window.innerWidth - 15.5 &&
          word.top >= g.top - 0.5 &&
          word.bottom <= g.bottom + 0.5,
        wordHeight: word.height / window.innerHeight,
        wordWidth: word.width / window.innerWidth,
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
        from: chip("from"),
        to: chip("to"),
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.wordInside).toBe(true);
    expect(during.wordHeight).toBeGreaterThan(0.06);
    expect(during.wordWidth).toBeGreaterThan(0.4);
    // On a phone, "One-on-one" spans the band side to side (16px gutter kept): big, not a pill.
    if (page.viewportSize()!.width < 500) expect(during.wordWidth).toBeGreaterThan(0.8);
    expect(during.stillPlaying).toBe(true);
    expect(during.hitOutside).toBe(true);
    // Held: "One-on-one" is the inverted (active) word.
    expect(during).toMatchObject({ from: "0", to: "1" });

    await expectGrowth(page);
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("header")).toHaveCSS("background-color", CHARCOAL);
    const heading = opener(page).getByRole("heading", {
      name: "the marketing side, done for you.",
    });
    await expect(heading).toBeInViewport();
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the bands cover the whole screen, no gaps, before the swap", async ({ page }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const early = await page.evaluate(async (at) => {
      await new Promise((r) => setTimeout(r, Math.max(0, at + 120 - performance.now())));
      const outer = document.querySelector('.sa-bw-band[data-band="0"]')!.getBoundingClientRect();
      return {
        theme: document.documentElement.getAttribute("data-sa-theme"),
        // The outer bands start last: still on their way in.
        outerLeft: outer.left,
        outerRight: outer.right,
      };
    }, start.at);
    expect(early.theme).toBe("app");
    expect(early.outerLeft).toBeLessThan(0);

    await expectGrowth(page);
    const s = (await swapBw(page))!;
    expect(s).not.toBeNull();
    expect(s.dt).toBeGreaterThanOrEqual(320);
    expect(s.bands).toHaveLength(5);
    // Every band all the way in, side to side, and each one reaching the next.
    for (const b of s.bands) {
      expect(b.left).toBeLessThanOrEqual(0.5);
      expect(b.right).toBeGreaterThanOrEqual(s.vw - 0.5);
    }
    expect(s.bands[0].top).toBeLessThanOrEqual(0.5);
    expect(s.bands[4].bottom).toBeGreaterThanOrEqual(s.vh - 0.5);
    for (let i = 1; i < 5; i++) expect(s.bands[i].top).toBeLessThanOrEqual(s.bands[i - 1].bottom);
    // "The app" is still the inverted (active) word at the swap.
    expect(s).toMatchObject({ from: "1", to: "0" });
  });

  test("scrolling up, charcoal bands fly apart onto paper; the next way down is quiet", async ({
    page,
  }) => {
    await page.goto(LOOK_4);
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
    expect(out.bands?.anims).toEqual(expect.arrayContaining(["sa-bw-out-left", "sa-bw-out-right"]));
    expect(out.bands?.anims).toHaveLength(5);
    expect(out.bands?.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);
    expect(out.edges).toBe(0);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    expect(quiet.bands?.anims).toEqual(
      expect.arrayContaining(["sa-bw-out-left", "sa-bw-out-right"]),
    );
    expect(quiet.bands?.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(await noOverflow(page)).toBe(true);
  });

  test("at the end the bands fly back out the way they came, outer ones first", async ({
    page,
  }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const end = await page.evaluate(async (at) => {
      const lefts = () =>
        [...document.querySelectorAll(".sa-bw-band")].map((b) => b.getBoundingClientRect().left);
      await new Promise((r) => setTimeout(r, Math.max(0, at + 1000 - performance.now())));
      const held = lefts();
      // Every frame from the hold to cleanup (the CSS clock can trail the page's timers a little).
      const frames: number[][] = [];
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (document.documentElement.getAttribute("data-sa-switching") !== "in") return resolve();
          frames.push(lefts());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { held, frames, vw: window.innerWidth };
    }, start.at);
    for (const left of end.held) expect(Math.abs(left)).toBeLessThanOrEqual(0.5);
    // The outer bands lead, back to the left, while the words still hold the middle.
    expect(
      end.frames.some(([top, , middle, , bottom]) => top < -1 && bottom < -1 && middle === 0),
    ).toBe(true);
    // Their neighbours go back to the right.
    expect(end.frames.some(([, second, , fourth]) => second > 1 && fourth > 1)).toBe(true);
    // The middle band never leads.
    for (const [top, , middle] of end.frames) expect(top).toBeLessThanOrEqual(middle);
    // All gone by the end.
    const last = end.frames[end.frames.length - 1];
    for (const left of last) expect(Math.abs(left)).toBeGreaterThanOrEqual(end.vw - 0.5);
    await expectGrowth(page);
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto(LOOK_4);
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

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    await expect(page.locator("#growth h2")).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("there is no switch to tap: the big words are decoration only", async ({ page }) => {
    await page.goto(LOOK_4);
    await settle(page);
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "4");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toBeHidden();
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOOK_4);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "4");
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });
});

/*
 * TEMPORARY preview look 5, "Blinds" (`/?look=5`): the same switch (scrolling decides,
 * hysteresis, held input, instant for reduced motion), a different picture. Runs at 375px (mobile
 * project) and on desktop. Remove with the `?look=` chooser once a look is picked.
 */
test.describe("homepage switch, look 5: blinds", () => {
  const LOOK_5 = "/?look=5";
  const swapBl = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwapBl);

  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("scrolling past the boundary drops the blind and shuts it, then the site is charcoal on the opener", async ({
    page,
  }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "5");
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "5");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    expect(start.stage).toBe(true);
    expect(start.graphic).toBe(true);
    // No edges: the blind drops, and at the end its slats tilt open where it hangs.
    expect(start.edges).toBe(0);
    expect(start.slats?.lift).toEqual(["sa-bl-drop"]);
    expect(start.slats?.anims).toEqual(
      expect.arrayContaining(["sa-bl-shut", "sa-bl-tilt", "sa-bl-open"]),
    );
    expect(start.slats?.anims).toHaveLength(24);
    expect(start.slats?.bg).toBe(CHARCOAL);

    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      await until(250);
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      await until(950);
      // Slat 3's word (every slat has one).
      const label = document
        .querySelector('.sa-bl-slat[data-slat="3"] .sa-bl-label[data-label="to"]')!
        .getBoundingClientRect();
      // Every slat's "One-on-one", each inside its own slat.
      const rows = [...document.querySelectorAll(".sa-bl-slat")].map((slat) => {
        const r = slat.getBoundingClientRect();
        const l = slat.querySelector('.sa-bl-label[data-label="to"]')!.getBoundingClientRect();
        return l.top >= r.top - 0.5 && l.bottom <= r.bottom + 0.5 && l.height > r.height * 0.4;
      });
      const g = document.querySelector("[data-sa-switch-graphic]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(window.innerWidth / 2, g.top + g.height / 2);
      const stage = document.querySelector("[data-sa-switch-stage]")!;
      const chip = (side: string) =>
        getComputedStyle(document.querySelector(`.sa-bl-label[data-label="${side}"] .sa-bl-chip`)!)
          .opacity;
      const shown = (side: string) =>
        getComputedStyle(document.querySelector(`.sa-bl-label[data-label="${side}"]`)!).opacity;
      return {
        early,
        overflow: overflow || doc.scrollWidth > doc.clientWidth,
        // "One-on-one" fits the screen side to side (16px gutter).
        labelInside: label.left >= 15.5 && label.right <= window.innerWidth - 15.5,
        labelWidth: label.width / window.innerWidth,
        rows,
        fromShown: shown("from"),
        toShown: shown("to"),
        hitOutside: !!hit && !stage.contains(hit),
        stillPlaying: doc.getAttribute("data-sa-switching") === "in",
        from: chip("from"),
        to: chip("to"),
      };
    }, start.at);
    expect(during.early).toEqual(["1", "1"]);
    expect(during.overflow).toBe(false);
    expect(during.labelInside).toBe(true);
    // Eight rows, a word filling each slat (and as wide as the gutter allows on a phone).
    expect(during.rows).toEqual(Array(8).fill(true));
    if (page.viewportSize()!.width < 500) expect(during.labelWidth).toBeGreaterThan(0.8);
    expect(during.stillPlaying).toBe(true);
    expect(during.hitOutside).toBe(true);
    // Held: "One-on-one" is the inverted (active) word, and the only one showing.
    expect(during).toMatchObject({ from: "0", to: "1", fromShown: "0", toShown: "1" });

    await expectGrowth(page);
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("header")).toHaveCSS("background-color", CHARCOAL);
    const heading = opener(page).getByRole("heading", {
      name: "the marketing side, done for you.",
    });
    await expect(heading).toBeInViewport();
    const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(0.5);
    expect(await landed(page)).toEqual(["1", "1"]);
    const grid: [number, number][] = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) grid.push([fx, fy]);
    for (const bg of await surfacesAt(page, grid)) expect(bg).not.toBe(PAPER);
    expect(await noOverflow(page)).toBe(true);
    expect(count(await saLog(page), "in")).toBe(1);
  });

  test("the slats are open while the blind drops, and shut with no gaps before the swap", async ({
    page,
  }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const early = await page.evaluate(async (at) => {
      await new Promise((r) => setTimeout(r, Math.max(0, at + 200 - performance.now())));
      const slat = document.querySelector('.sa-bl-slat[data-slat="3"]')!.getBoundingClientRect();
      return {
        theme: document.documentElement.getAttribute("data-sa-theme"),
        // Still dropping, and open: a thin stripe of its 12.5% share of the screen.
        share: slat.height / (window.innerHeight / 8),
        back: getComputedStyle(document.querySelector(".sa-bl-back")!).opacity,
        card: getComputedStyle(document.querySelector(".sa-bl-card")!).opacity,
      };
    }, start.at);
    expect(early.theme).toBe("app");
    expect(early.share).toBeLessThan(0.3);
    expect(early.back).toBe("0");
    // Open slats are plain charcoal bars: the title is printed on them only once they're shut.
    expect(early.card).toBe("0");

    await expectGrowth(page);
    const s = (await swapBl(page))!;
    expect(s).not.toBeNull();
    expect(s.dt).toBeGreaterThanOrEqual(530);
    // The blind is all the way down, the backing is on, and every slat is shut side to side,
    // each one reaching the next.
    expect(s.lift.top).toBeLessThanOrEqual(0.5);
    expect(s.lift.bottom).toBeGreaterThanOrEqual(s.vh - 0.5);
    expect(s.back).toBe("1");
    expect(s.slats).toHaveLength(8);
    for (const b of s.slats) {
      expect(b.left).toBeLessThanOrEqual(0.5);
      expect(b.right).toBeGreaterThanOrEqual(s.vw - 0.5);
    }
    expect(s.slats[0].top).toBeLessThanOrEqual(0.5);
    expect(s.slats[7].bottom).toBeGreaterThanOrEqual(s.vh - 0.5);
    for (let i = 1; i < 8; i++) expect(s.slats[i].top).toBeLessThanOrEqual(s.slats[i - 1].bottom);
    // "The app" is still the inverted (active) label at the swap.
    expect(s).toMatchObject({ from: "1", to: "0" });
  });

  test("scrolling up, a charcoal blind tilts open onto paper; the next way down is quiet", async ({
    page,
  }) => {
    await page.goto(LOOK_5);
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
    expect([...new Set(out.slats?.anims)]).toEqual(["sa-bl-open"]);
    expect(out.slats?.anims).toHaveLength(8);
    expect(out.slats?.lift).toEqual([]);
    expect(out.slats?.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);
    expect(out.edges).toBe(0);

    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    log = await saLog(page);
    expect(log).toContain("in-quiet");
    expect(log).not.toContain("in");
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    expect([...new Set(quiet.slats?.anims)]).toEqual(["sa-bl-open"]);
    expect(quiet.slats?.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(await noOverflow(page)).toBe(true);
  });

  test("at the end the slats tilt open and the opener shows through", async ({ page }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;
    const end = await page.evaluate(async (at) => {
      const look = () => {
        const blind = document.querySelector(".sa-bl-blind")!.getBoundingClientRect();
        const slat = document.querySelector('.sa-bl-slat[data-slat="3"]')!.getBoundingClientRect();
        return {
          top: blind.top,
          share: slat.height / (window.innerHeight / 8),
          back: Number(getComputedStyle(document.querySelector(".sa-bl-back")!).opacity),
        };
      };
      await new Promise((r) => setTimeout(r, Math.max(0, at + 1000 - performance.now())));
      const held = look();
      // Every frame from the hold to cleanup (the CSS clock can trail the page's timers a little).
      const frames: ReturnType<typeof look>[] = [];
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (document.documentElement.getAttribute("data-sa-switching") !== "in") return resolve();
          frames.push(look());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { held, frames };
    }, start.at);
    expect(end.held.back).toBe(1);
    expect(end.held.share).toBeGreaterThan(0.99);
    // The blind stays where it hangs the whole time; it never goes up.
    for (const f of end.frames) expect(Math.abs(f.top)).toBeLessThanOrEqual(0.5);
    // The slats open with the backing off, so the opener shows through.
    expect(end.frames.some((f) => f.back < 0.01 && f.share < 0.5)).toBe(true);
    for (const f of end.frames) if (f.share < 0.99) expect(f.back).toBeLessThan(0.01);
    await expectGrowth(page);
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("hysteresis: wiggling near the boundary never strobes", async ({ page }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    for (const f of [0.9, 0.98, 0.88, 0.99, 0.86, 0.95]) {
      await scrollBoundaryTo(page, f);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(0);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
  });

  test("no layout shift from the switch", async ({ page }) => {
    await page.goto(LOOK_5);
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

  test("a fling during the show can't carry the page past the opener", async ({ page }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await stepBoundaryTo(page, 0.6);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(40);
    }
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expectGrowth(page);
    await expect(page.locator("#growth h2")).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
  });

  test("there is no switch to tap: the blind is decoration only", async ({ page }) => {
    await page.goto(LOOK_5);
    await settle(page);
    await expect(page.locator("[data-sa-look-stage]")).toHaveAttribute("data-sa-look-stage", "5");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.locator("[aria-pressed]")).toHaveCount(0);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).toHaveAttribute("aria-hidden", "true");
    await expect(stage).toHaveAttribute("inert", "");
    await expect(stage.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
    await expect(stage).toBeHidden();
  });

  test("reduced motion: an instant swap both ways, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOOK_5);
    await settle(page);
    await expect(html(page)).toHaveAttribute("data-sa-look", "5");
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await expect(opener(page)).toBeInViewport();
    expect(await landed(page)).toEqual(["1", "1"]);
    await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    expect(await noOverflow(page)).toBe(true);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });
});

/*
 * TEMPORARY preview looks 1–5: what GrowthSwitch shares between looks, checked against each
 * look's own clock (taps and scrolling are held until its doneMs; a look whose cover lifted early
 * would leave taps blocked on a visible page). Remove with the `?look=` chooser.
 */
const LOOK_THEME_AT: Record<string, number> = {
  "1": LIGHT_THEME_AT_MS,
  "2": CURTAIN_THEME_AT_MS,
  "3": TIDE_THEME_AT_MS,
  "4": BW_THEME_AT_MS,
  "5": BL_THEME_AT_MS,
};
for (const [id, themeAt] of Object.entries(LOOK_THEME_AT)) {
  test.describe(`homepage switch, look ${id}: shared behaviour`, () => {
    const URL = `/?look=${id}`;

    test.beforeEach(async ({ page }) => {
      await recordSwitches(page);
    });

    test("taps during the show land on nothing; after it, taps work", async ({ page }) => {
      await page.goto(URL);
      await settle(page);
      await stepBoundaryTo(page, 0.4);
      await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
      const shownAt = Date.now();
      const url = page.url();
      // The chapter bar's "Book a free call" link is right there under the show.
      const link = await page.evaluate(() => {
        const r = document
          .querySelector('[data-growth-chapter] a[href="#growth-call"]')!
          .getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: window.innerHeight };
      });
      expect(link.y).toBeGreaterThan(0);
      expect(link.y).toBeLessThan(link.h);
      await page.mouse.click(link.x, link.y);
      // Again once the screen is covered and the page has moved to the opener.
      await page.waitForTimeout(Math.max(0, themeAt + 120 - (Date.now() - shownAt)));
      const vp = page.viewportSize()!;
      await page.mouse.click(vp.width / 2, vp.height / 2);
      await page.mouse.click(link.x, link.y);
      // Every tap happened while the show was up.
      await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
      await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
      await expectGrowth(page);
      expect(page.url()).toBe(url);
      await expect(page.getByRole("region", { name: "Book a free call" })).not.toBeInViewport();
      expect(
        await page.evaluate(
          () => document.activeElement === document.body || !document.activeElement,
        ),
      ).toBe(true);
      // The show is over: nothing of it is left on screen, and taps work again.
      await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
      await page
        .getByRole("navigation", { name: "Growth" })
        .getByRole("link", { name: "Book a free call" })
        .click();
      await expect(page).toHaveURL(/#growth-call$/);
    });

    test("Back during the show: an instant swap at the end, no wipe", async ({ page }) => {
      await page.goto(URL);
      await settle(page);
      await page.evaluate(() => window.history.pushState(null, "", "#top-of-page"));
      await stepBoundaryTo(page, 0.4);
      await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
      await page.evaluate(() => window.history.back());
      await expect(page).toHaveURL(new RegExp(`/\\?look=${id}$`));
      await expectApp(page);
      await expect(html(page)).toHaveAttribute("data-sa-look", id);
      await expect(page.getByRole("region", { name: "Introduction" })).toBeInViewport();
      await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
      const log = await saLog(page);
      expect(count(log, "in")).toBe(1);
      expect(log.slice(log.indexOf("in"))).not.toContain("out");
      expect(log.slice(log.indexOf("in"))).not.toContain("in-quiet");
    });

    test("leaving the homepage takes the look with it", async ({ page }) => {
      await page.goto(URL);
      await settle(page);
      await stepBoundaryTo(page, 0.4);
      await expectGrowth(page);
      await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
      await expect(page).toHaveURL(/\/privacy$/);
      await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
      await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
      await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/);
      await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    });
  });
}

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

  test("a preview look (?look=1) changes nothing without JavaScript", async ({ page }) => {
    await page.goto("/?look=1");
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator(".sa-ls-plate")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("a preview look (?look=2) changes nothing without JavaScript", async ({ page }) => {
    await page.goto("/?look=2");
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator(".sa-cu-half")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("a preview look (?look=3) changes nothing without JavaScript", async ({ page }) => {
    await page.goto("/?look=3");
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator(".sa-td-water")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("a preview look (?look=4) changes nothing without JavaScript", async ({ page }) => {
    await page.goto("/?look=4");
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator(".sa-bw-band")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("a preview look (?look=5) changes nothing without JavaScript", async ({ page }) => {
    await page.goto("/?look=5");
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-sa-theme", /.*/);
    await expect(growthHalf(page)).toHaveCSS("background-color", CHARCOAL);
    await expect(
      opener(page).getByRole("heading", { name: "the marketing side, done for you." }),
    ).toBeVisible();
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await expect(page.locator(".sa-bl-slat")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
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
