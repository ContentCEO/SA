import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { formatGrowthBlock } from "../../src/server/growth-note";
import {
  BW_COVERED_AT_MS,
  BW_THEME_AT_MS,
} from "../../src/components/marketing/growth/big-words-rules";
import { seedAdmin, signInAs, testDb } from "./support";

const unique = (p = "growth") =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

type Box = { left: number; right: number; top: number; bottom: number };
type SaWindow = Window & {
  __saLog: string[];
  __saVis: {
    v: string;
    at: number;
    stage: boolean;
    graphic: boolean;
    /**
     * The animations on the five bands, whether every one of them starts from 0 (running, not a
     * finished one kept from the last transition), and the middle band's colour.
     */
    bands: { anims: string[]; fresh: boolean; bg: string };
  }[];
  /** Every frame while a transition plays: which one, and how many bands were on screen. */
  __saFrames: { v: string; on: number }[];
  /** Where the bands were, and which word was inverted, when the theme swapped in a full show. */
  __saSwap: {
    dt: number;
    bands: Box[];
    vw: number;
    vh: number;
    from: string;
    to: string;
  } | null;
};

/**
 * Records every change of <html data-sa-theme> ("theme:app" / "theme:growth") and
 * data-sa-switching ("in" / "in-quiet" / "out", "end" when removed) from the first paint, plus
 * what the stage showed at the start of each transition and where the bands were at the full
 * show's swap. No hook in the product code.
 */
async function recordSwitches(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SaWindow;
    w.__saLog = [];
    w.__saVis = [];
    w.__saSwap = null;
    w.__saFrames = [];
    let inAt = 0;
    const bands = () => [...document.querySelectorAll(".sa-bw-band")];
    // A band is on screen unless it's all the way off to one side.
    const sample = () => {
      const v = document.documentElement?.getAttribute("data-sa-switching");
      if (v) {
        const vw = window.innerWidth;
        const on = bands().filter((b) => Math.abs(b.getBoundingClientRect().left) < vw - 1);
        w.__saFrames.push({ v, on: on.length });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const chip = (side: string) =>
      getComputedStyle(document.querySelector(`.sa-bw-word[data-word="${side}"] .sa-bw-chip`)!)
        .opacity;
    // Init scripts can run before <html> exists: watch the document and keep only <html>.
    new MutationObserver((records) => {
      const root = document.documentElement;
      const mine = records.filter((r) => r.target === root);
      mine.forEach((r, i) => {
        // The value this mutation set: the next one's old value, or what's there now (a removal
        // and a new value can arrive in one batch, e.g. "out" ending straight into "in-quiet").
        const next = mine.slice(i + 1).find((n) => n.attributeName === r.attributeName);
        const v = next ? next.oldValue : root.getAttribute(r.attributeName!);
        if (r.attributeName === "data-sa-theme") {
          w.__saLog.push(`theme:${v ?? "none"}`);
          if (v === "growth" && root.getAttribute("data-sa-switching") === "in") {
            w.__saSwap = {
              dt: performance.now() - inAt,
              bands: bands().map((b) => {
                const box = b.getBoundingClientRect();
                return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
              }),
              vw: window.innerWidth,
              vh: window.innerHeight,
              from: chip("from"),
              to: chip("to"),
            };
          }
          return;
        }
        w.__saLog.push(v ?? "end");
        if (!v) return;
        if (v === "in") inAt = performance.now();
        const all = bands();
        const shown = (s: string) => !!document.querySelector(s)?.checkVisibility();
        const anims = all.flatMap((b) => b.getAnimations() as CSSAnimation[]);
        w.__saVis.push({
          v,
          at: performance.now(),
          stage: shown("[data-sa-switch-stage]"),
          graphic: shown("[data-sa-switch-graphic]"),
          bands: {
            anims: anims.map((a) => a.animationName),
            fresh: anims.every((a) => a.playState === "running" && Number(a.currentTime) < 20),
            bg: getComputedStyle(all[2]).backgroundColor,
          },
        });
      });
    }).observe(document, {
      attributes: true,
      attributeOldValue: true,
      subtree: true,
      attributeFilter: ["data-sa-theme", "data-sa-switching"],
    });
  });
}

const saLog = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saLog);
const saVis = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saVis);
const saSwap = (page: Page) => page.evaluate(() => (window as unknown as SaWindow).__saSwap);
/** How many frames of transition `v` had at least one band on screen. */
const framesOnScreen = (page: Page, v: string) =>
  page.evaluate(
    (t) => (window as unknown as SaWindow).__saFrames.filter((f) => f.v === t && f.on > 0).length,
    v,
  );
const resetLog = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as SaWindow;
    w.__saLog = [];
    w.__saVis = [];
    w.__saSwap = null;
    w.__saFrames = [];
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
const heroLink = (page: Page) =>
  page
    .getByRole("region", { name: "Introduction" })
    .getByRole("link", { name: "Want more work coming in? See Squared Away Growth" });
const headerGrowthLink = (page: Page) =>
  page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Growth", exact: true });
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

/**
 * The full Big words show just played, once, from a reset log (or a fresh page): the bands came
 * in with the words, covered every bit of the screen when the theme swapped with "The app" still
 * the inverted word, flew back out, and the page landed on the opener with its headline in.
 */
async function expectFullShow(page: Page) {
  await expectGrowth(page);
  const log = await saLog(page);
  expect(count(log, "in")).toBe(1);
  expect(log).not.toContain("in-quiet");
  const start = (await saVis(page)).find((x) => x.v === "in")!;
  expect(start.stage).toBe(true);
  expect(start.graphic).toBe(true);
  // Each band comes in and, at the end, flies back out.
  expect(start.bands.anims).toHaveLength(10);
  expect(start.bands.anims).toEqual(
    expect.arrayContaining([
      "sa-bw-in-left",
      "sa-bw-in-right",
      "sa-bw-out-left",
      "sa-bw-out-right",
    ]),
  );
  expect(start.bands.fresh).toBe(true);
  expect(start.bands.bg).toBe(CHARCOAL);
  const s = (await saSwap(page))!;
  expect(s).not.toBeNull();
  expect(s.dt).toBeGreaterThanOrEqual(BW_COVERED_AT_MS);
  expect(s.bands).toHaveLength(5);
  // Every band all the way in, side to side, and each one reaching the next.
  for (const b of s.bands) {
    expect(b.left).toBeLessThanOrEqual(0.5);
    expect(b.right).toBeGreaterThanOrEqual(s.vw - 0.5);
  }
  expect(s.bands[0].top).toBeLessThanOrEqual(0.5);
  expect(s.bands[4].bottom).toBeGreaterThanOrEqual(s.vh - 0.5);
  for (let i = 1; i < 5; i++) expect(s.bands[i].top).toBeLessThanOrEqual(s.bands[i - 1].bottom);
  expect(s).toMatchObject({ from: "1", to: "0" });

  await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
  const heading = opener(page).getByRole("heading", { name: "the marketing side, done for you." });
  await expect(heading).toBeInViewport();
  // The switch lands on the opener: at the top, under the chapter bar.
  const top = await heading.evaluate((h) => h.getBoundingClientRect().top / window.innerHeight);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(0.5);
  expect(await landed(page)).toEqual(["1", "1"]);
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

/*
 * The homepage switch, "Big words": runs at 375px (mobile project) and on desktop. Scrolling
 * decides it (hysteresis, no strobing); every crossing from the app into Growth plays the full
 * show and lands on the opener; every way back up is the quiet "out".
 */
test.describe("homepage: the way into Squared Away Growth", () => {
  test.beforeEach(async ({ page }) => {
    await recordSwitches(page);
  });

  test("hero link, header link, landmarks and no sideways scroll", async ({ page }) => {
    await page.goto("/");
    const hero = heroLink(page);
    await expect(hero).toHaveAttribute("href", "#growth");
    expect((await hero.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const header = headerGrowthLink(page);
    const wide = page.viewportSize()!.width >= 640;
    if (wide) await expect(header).toBeVisible();
    else await expect(header).toBeHidden();

    expect(await noOverflow(page)).toBe(true);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(
      page.getByRole("main").getByRole("region", { name: "Ask Davi to call me" }),
    ).toHaveCount(1);
    await expect(page.getByRole("banner")).toHaveCount(1);

    await settle(page);
    await hero.click();
    // The way in is the switch too: the show plays and the page moves to the opener under it.
    await expectFullShow(page);
    await expect(page).toHaveURL(/\/#growth$/);

    // The tap added a history entry, as the link would: Back returns to the top of the homepage.
    await resetLog(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Introduction" })).toBeInViewport();
    await expectApp(page);
    const back = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(back).not.toContain(v);
  });

  test("the header Growth link plays the full show every time it's tapped from the app side (desktop)", async ({
    page,
  }) => {
    test.skip(page.viewportSize()!.width < 640, "the header link shows from sm up");
    await page.goto("/");
    await settle(page);
    await headerGrowthLink(page).click();
    await expectFullShow(page);
    await expect(page).toHaveURL(/\/#growth$/);
    const entries = await page.evaluate(() => window.history.length);

    // Back to the top: the bands fly apart onto paper.
    await resetLog(page);
    await stepToTop(page);
    await expectApp(page);
    expect(await saLog(page)).toContain("out");

    // Tapped again from the top: the whole show again, onto the opener. The address already ends
    // in #growth, so (as the link itself would) it adds no second entry.
    await resetLog(page);
    await headerGrowthLink(page).click();
    await expectFullShow(page);
    await expect(page).toHaveURL(/\/#growth$/);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);

    // Already in Growth (scrolled up a little, so the header shows again): a plain jump to the
    // opener, no show.
    await stepBoundaryTo(page, 0.5);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
    const openerAt = () =>
      opener(page).evaluate((o) => o.getBoundingClientRect().top / window.innerHeight);
    expect(await openerAt()).toBeGreaterThan(0.5);
    await resetLog(page);
    await headerGrowthLink(page).click();
    await expect.poll(openerAt).toBeLessThan(0.3);
    await expectGrowth(page);
    await page.waitForTimeout(300);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });

  test("the hero link from the keyboard keeps the native jump: instant, no show", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await heroLink(page).focus();
    await page.keyboard.press("Enter");
    await expect(opener(page)).toBeInViewport();
    await expectGrowth(page);
    expect(count(await saLog(page), "in")).toBe(0);
  });

  test("after a show, tapping the hero link from the top plays the full show again", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);
    await stepToTop(page);
    await expectApp(page);
    await resetLog(page);
    await heroLink(page).click();
    await expectFullShow(page);
    await expect(page).toHaveURL(/\/#growth$/);
  });

  test("a link that lands inside the band picks the right side at once", async ({ page }) => {
    // How far below the waitlist's landing spot the Growth part starts (width decides it).
    await page.goto("/");
    const gap = await page.evaluate(() => {
      document.getElementById("waitlist")!.scrollIntoView({ block: "start" });
      return document.querySelector('[data-sa-half="growth"]')!.getBoundingClientRect().top;
    });
    // A screen tall enough that, after "Join the waitlist", Growth's top sits at 96% of it: inside
    // the band (85–100%), below the middle line (92.5%), so the app side is right.
    const width = page.viewportSize()!.width;
    await page.setViewportSize({ width, height: Math.round(gap / 0.96) });
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectGrowth(page);
    await page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Join the waitlist" })
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
    const call = bar.getByRole("link", { name: "Ask Davi to call me" });
    await expect(call).toHaveAttribute("href", "#growth-call");

    await page.getByRole("region", { name: "Pricing" }).scrollIntoViewIfNeeded();
    await expect(bar).not.toBeInViewport();

    await page.getByRole("region", { name: "Ground rules" }).scrollIntoViewIfNeeded();
    // Check 32 P3: scrolling into view now stops clear of the sticky bars (scroll-padding-top),
    // so go a little further down to be well inside the Growth part.
    await page.evaluate(() => window.scrollBy(0, 200));
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
      "You own everything",
      "How Growth works",
      "Ground rules",
      "Growth questions",
      "Ask Davi to call me",
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

  test("scrolling Growth up into view slams the bands in, then the whole site is charcoal", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    expect(await noOverflow(page)).toBe(true);
    await stepBoundaryTo(page, 0.4);
    await expect.poll(() => saLog(page)).toContain("in");
    const start = (await saVis(page)).find((x) => x.v === "in")!;

    // Nothing disappears before the screen is covered; nothing scrolls sideways as the bands
    // come in; the stage never takes a tap; "One-on-one" is huge, and the inverted word.
    const during = await page.evaluate(async (at) => {
      const until = (ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at + ms - performance.now())));
      await until(100);
      const early = [...document.querySelectorAll(".sa-land > span")].map(
        (s) => getComputedStyle(s).opacity,
      );
      const outer = document.querySelector('.sa-bw-band[data-band="0"]')!.getBoundingClientRect();
      const theme = document.documentElement.getAttribute("data-sa-theme");
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
        // The outer bands start last: still on their way in, on the old colours.
        outerLeft: outer.left,
        theme,
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
    expect(during.outerLeft).toBeLessThan(0);
    expect(during.theme).toBe("app");
    expect(during.overflow).toBe(false);
    expect(during.wordInside).toBe(true);
    expect(during.wordHeight).toBeGreaterThan(0.06);
    expect(during.wordWidth).toBeGreaterThan(0.4);
    // On a phone, "One-on-one" spans the band side to side (16px gutter kept): big, not a pill.
    if (page.viewportSize()!.width < 500) expect(during.wordWidth).toBeGreaterThan(0.8);
    expect(during.stillPlaying).toBe(true);
    expect(during.hitOutside).toBe(true);
    expect(during).toMatchObject({ from: "0", to: "1" });

    await expectFullShow(page);
    await expect(page.locator("body")).toHaveCSS("background-color", CHARCOAL);
    await expect(page.locator("header")).toHaveCSS("background-color", CHARCOAL);
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
    const call = page.getByRole("region", { name: "Ask Davi to call me" });
    await expect(call.locator(".sa-light")).toHaveCSS("background-color", "rgb(239, 238, 234)");
    await expect(call.getByLabel("Your name")).toHaveCSS("border-top-color", "rgb(94, 93, 89)");
  });

  test("every way down plays the full show again; every way up flies apart onto paper", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);

    for (let round = 2; round <= 3; round++) {
      // Up: charcoal bands fly apart onto paper, no words.
      await resetLog(page);
      await stepBoundaryTo(page, 1.1);
      await expectApp(page);
      await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
      await expect(page.locator("header")).toHaveCSS("background-color", PAPER);
      expect(await noOverflow(page)).toBe(true);
      const log = await saLog(page);
      expect(count(log, "out"), `round ${round}`).toBe(1);
      expect(log).not.toContain("in");
      const out = (await saVis(page)).find((x) => x.v === "out")!;
      expect(out.bands.anims).toEqual(
        expect.arrayContaining(["sa-bw-out-left", "sa-bw-out-right"]),
      );
      expect(out.bands.anims).toHaveLength(5);
      expect(out.bands.fresh).toBe(true);
      expect(out.bands.bg).toBe(CHARCOAL);
      expect(out.graphic).toBe(false);
      expect(await framesOnScreen(page, "out")).toBeGreaterThan(0);

      // Down again: the whole show again, onto the opener.
      await resetLog(page);
      await stepBoundaryTo(page, 0.4);
      await expectFullShow(page);
      expect(await noOverflow(page)).toBe(true);
    }

    // Nothing of the shows is left behind: scrolling and taps work.
    const y = await page.evaluate(() => window.scrollY);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y);
    await page
      .getByRole("navigation", { name: "Growth" })
      .getByRole("link", { name: "Ask Davi to call me" })
      .click();
    await expect(page).toHaveURL(/#growth-call$/);
  });

  test("a way down during the wipe waits for it, then plays the quiet bands: one at a time", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);

    // Up past the bottom edge, and straight back down while the bands are still flying apart.
    await resetLog(page);
    await page.evaluate(async () => {
      const el = document.querySelector('[data-sa-half="growth"]')!;
      const to = (f: number) =>
        window.scrollTo(
          0,
          el.getBoundingClientRect().top + window.scrollY - f * window.innerHeight,
        );
      const root = document.documentElement;
      to(1.1);
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (root.getAttribute("data-sa-switching") === "out") resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      });
      to(0.4);
    });
    await expectGrowth(page);
    const log = await saLog(page);
    expect(count(log, "out")).toBe(1);
    expect(count(log, "in-quiet")).toBe(1);
    expect(log).not.toContain("in");
    expect(log.indexOf("in-quiet")).toBeGreaterThan(log.indexOf("out"));
    const quiet = (await saVis(page)).find((x) => x.v === "in-quiet")!;
    expect(quiet.bands.anims).toEqual(
      expect.arrayContaining(["sa-bw-out-left", "sa-bw-out-right"]),
    );
    expect(quiet.bands.anims).toHaveLength(5);
    // Queued, it starts in the same task the wipe ended: the bands still really fly, from 0 (a
    // finished wipe's animations kept on would leave them off-screen: a bare colour cut).
    expect(quiet.bands.fresh).toBe(true);
    expect(await framesOnScreen(page, "in-quiet")).toBeGreaterThan(0);
    expect(quiet.bands.bg).toBe(PAPER);
    expect(quiet.graphic).toBe(false);
    expect(await noOverflow(page)).toBe(true);

    // A clean way up and down again: the full show.
    await stepBoundaryTo(page, 1.1);
    await expectApp(page);
    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);
  });

  test("a way up during the full show waits for it, then the bands fly apart onto paper", async ({
    page,
  }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    // Back to the top (a scrollbar drag isn't held) after the last realign, while the bands are
    // still flying out: the way up waits for the show to end.
    await page.evaluate(async () => {
      const w = window as unknown as SaWindow;
      const at = await new Promise<number>((resolve) => {
        const tick = () => {
          const start = w.__saVis.find((x) => x.v === "in");
          if (start) resolve(start.at);
          else requestAnimationFrame(tick);
        };
        tick();
      });
      await new Promise((r) => setTimeout(r, Math.max(0, at + 1400 - performance.now())));
      window.scrollTo(0, 0);
    });
    await expectApp(page);
    const log = await saLog(page);
    expect(count(log, "in")).toBe(1);
    expect(count(log, "out")).toBe(1);
    expect(log.indexOf("out")).toBeGreaterThan(log.indexOf("in"));
    expect(log).not.toContain("in-quiet");
    const out = (await saVis(page)).find((x) => x.v === "out")!;
    expect(out.bands.anims).toEqual(expect.arrayContaining(["sa-bw-out-left", "sa-bw-out-right"]));
    expect(out.bands.anims).toHaveLength(5);
    // Queued, it starts in the same task the show ended, and still flies from 0 on screen.
    expect(out.bands.fresh).toBe(true);
    expect(await framesOnScreen(page, "out")).toBeGreaterThan(0);
    expect(out.bands.bg).toBe(CHARCOAL);
    expect(out.graphic).toBe(false);
    await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Down again: the whole show.
    await resetLog(page);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);
  });

  test("at the end the bands fly back out the way they came, outer ones first", async ({
    page,
  }) => {
    await page.goto("/");
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
    await expectFullShow(page);
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
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
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
      .getByRole("link", { name: "Ask Davi to call me" });
    await expect(call).toBeFocused();
    await expect(html(page)).not.toHaveAttribute("data-sa-switching", /.*/);
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
    await page.waitForTimeout(600);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });

  test("taps during the show land on nothing; after it, taps work", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await stepBoundaryTo(page, 0.4);
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    const shownAt = Date.now();
    const url = page.url();
    // The chapter bar's "Ask Davi to call me" link is right there under the bands.
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
    await page.waitForTimeout(Math.max(0, BW_THEME_AT_MS + 120 - (Date.now() - shownAt)));
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.mouse.click(link.x, link.y);
    // Every tap happened while the show was up.
    await expect(html(page)).toHaveAttribute("data-sa-switching", "in");
    await expect(html(page)).toHaveAttribute("data-sa-theme", "growth");
    await expectGrowth(page);
    expect(page.url()).toBe(url);
    await expect(page.getByRole("region", { name: "Ask Davi to call me" })).not.toBeInViewport();
    expect(
      await page.evaluate(
        () => document.activeElement === document.body || !document.activeElement,
      ),
    ).toBe(true);
    // The show is over: nothing of it is left on screen, and taps work again.
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    await page
      .getByRole("navigation", { name: "Growth" })
      .getByRole("link", { name: "Ask Davi to call me" })
      .click();
    await expect(page).toHaveURL(/#growth-call$/);
  });

  test("there is no switch to tap: the big words are decoration only", async ({ page }) => {
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

  test("reduced motion: an instant swap both ways, every time, no show", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await settle(page);
    for (let round = 0; round < 2; round++) {
      await stepBoundaryTo(page, 0.4);
      await expectGrowth(page);
      await expect(opener(page)).toBeInViewport();
      expect(await landed(page)).toEqual(["1", "1"]);
      await expect(page.locator("[data-sa-switch-stage]")).toHaveCSS("display", "none");
      expect(await noOverflow(page)).toBe(true);
      await stepBoundaryTo(page, 1.1);
      await expectApp(page);
      await expect(page.locator("body")).toHaveCSS("background-color", PAPER);
    }
    // The way in from the hero is a plain jump too.
    await stepToTop(page);
    await expectApp(page);
    await heroLink(page).click();
    await expect(opener(page)).toBeInViewport();
    await expectGrowth(page);
    const log = await saLog(page);
    for (const v of ["in", "in-quiet", "out"]) expect(log).not.toContain(v);
  });

  test("deep links and reloads land in Growth without a show", async ({ page }) => {
    await page.goto("/#growth-call");
    await expectGrowth(page);
    await expect(page.getByRole("region", { name: "Ask Davi to call me" })).toBeInViewport();
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

  test("a ?look= link changes nothing any more: Big words is the one show", async ({ page }) => {
    // The old preview chooser's pictures and attributes are gone, whatever the link asks for.
    for (const id of ["2", "3", "4", "5"]) {
      await page.goto(`/?look=${id}`);
      await expect(html(page)).toHaveAttribute("data-sa-theme", "app");
      await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    }
    await page.goto("/?look=1");
    await settle(page);
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
    const stage = page.locator("[data-sa-switch-stage]");
    await expect(stage).not.toHaveAttribute("data-sa-look-stage", /.*/);
    await expect(stage.locator(".sa-bw-band")).toHaveCount(5);
    await expect(
      page.locator(".sa-switch-flood, .sa-ls-plate, .sa-cu-half, .sa-td-water, .sa-bl-slat"),
    ).toHaveCount(0);
    await stepBoundaryTo(page, 0.4);
    await expectFullShow(page);
    await expect(html(page)).not.toHaveAttribute("data-sa-look", /.*/);
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
    const links = growthHalf(page).getByRole("link", { name: "Ask Davi to call me" });
    await expect(links).toHaveCount(2);
    for (const l of await links.all()) await expect(l).toBeVisible();
    const call = page.getByRole("region", { name: "Ask Davi to call me" });
    for (const label of ["Your name", /^Phone/, /^Email/, "Trade"]) {
      await expect(call.getByLabel(label)).toBeVisible();
    }
    await expect(page.locator("[data-sa-switch-stage]")).toBeHidden();
    for (const band of await page.locator(".sa-bw-band").all()) await expect(band).toBeHidden();
    expect(await noOverflow(page)).toBe(true);
  });
});

test.describe("Ask Davi to call me", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" } });

  test("plain errors, focus on what needs fixing, then a thank-you and one stored request", async ({
    page,
  }) => {
    const email = unique();
    await page.goto("/#growth-call");
    const form = page.getByRole("region", { name: "Ask Davi to call me" });
    const submit = form.getByRole("button", { name: "Ask Davi to call me" });

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
    await expect(done).toContainText("Davi will call you at 617-555-0142.");
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
    const form = page.getByRole("region", { name: "Ask Davi to call me" });
    await form.getByLabel("Your name").fill("Bot");
    await form.getByLabel(/^Phone/).fill("617-555-0142");
    await form.getByLabel(/^Email/).fill(email);
    // Check 2 P3: the trap is out of the tab order and hidden from screen readers.
    const trap = form.locator('input[name="sa_hp"]');
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(trap.locator("xpath=ancestor::div[@aria-hidden]")).toHaveCount(1);
    await expect(form.getByRole("textbox", { name: "Leave this empty" })).toHaveCount(0);
    await trap.fill("http://spam.example", { force: true });
    await form.getByRole("button", { name: "Ask Davi to call me" }).click();
    await expect(form.getByRole("status")).toContainText("Davi will call you soon.");
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
  const block = (phone: string, at: string, services: string[], trapFilled = false) =>
    formatGrowthBlock({ at, services, phone, trapFilled });
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
      note: block("617-555-0142", "2026-10-12 09:12", ["Google ads", "Reviews"], true),
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
    "Not on the app waitlist. Asking for a Growth call never invites anyone.",
  );
  await expect(b).toContainText("Wants help with: Google ads, Reviews");
  // Check 2 P3: a request with the hidden field filled still shows, marked for Davi.
  await expect(b).toContainText("Might be a bot: the hidden field was filled");
  await expect(a).not.toContainText("Might be a bot");
  // No app invite on a Growth-only row: only the explicit Growth controls.
  await expect(b.getByRole("button", { name: /^Invite Sam/ })).toHaveCount(0);
  await expect(b.locator("summary", { hasText: /^Invite to Growth$/ })).toBeVisible();
  await expect(b.locator("summary", { hasText: /^Remove Growth request$/ })).toBeVisible();
  await expect(b).not.toContainText("growth-only");
  await expect(page.getByText("Earlier request")).toHaveCount(0);

  // A posted invite for a Growth-only email (e.g. a stale page) invites nobody and says why.
  await a
    .locator("form", { has: page.getByRole("button", { name: "Invite Rosa" }) })
    .locator('input[name="email"]')
    .evaluate((el, v) => {
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
    page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Ask Davi to call me" }),
  ).toHaveAttribute("href", "#growth-call");

  const call = page.getByRole("region", { name: "Ask Davi to call me" });
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

test("/growth: every service card says what you get (Check 3 P1)", async ({ page }) => {
  await page.goto("/growth");
  const services = page.getByRole("region", { name: "What we take on" });
  const reviews = services.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Reviews", exact: true }),
  });
  await expect(
    reviews.getByRole("list", { name: "What you get with Reviews" }).getByRole("listitem").first(),
  ).toHaveText("Your Google review link and a short message you can send");
  await expect(reviews).toContainText("we never message your customers");
  expect(await noOverflow(page)).toBe(true);
});

test("/growth: the new FAQs open to their answers (Check 3 P6, Check 34 P4)", async ({ page }) => {
  await page.goto("/growth");
  const faq = page.getByRole("region", { name: "Growth questions" });
  await faq.getByText("Who pays for the ads?").click();
  await expect(faq.getByText(/You set the monthly limit/)).toBeVisible();
  await faq.getByText("How is this different from a marketing agency?").click();
  await expect(faq.getByText(/no sales team and no hand-off/)).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test("/growth: no empty proof section while there's no real proof (Check 2 P6)", async ({
  page,
}) => {
  await page.goto("/growth");
  await expect(page.getByRole("region", { name: "What it looks like" })).toHaveCount(0);
  await expect(page.getByText("what it looks like,")).toHaveCount(0);
});
