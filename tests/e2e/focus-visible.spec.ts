import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

/**
 * Check 32 P3: focus never sits under a sticky bar on the public pages. Walks focus backwards
 * from the bottom of the page to the top; at each stop, the point in the middle of the focused
 * element must be the element (or inside it), not a bar drawn over it.
 */
async function coveredWalkingUp(page: Page) {
  const covered: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press("Shift+Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      const path: string[] = [];
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement)
        path.push(`${n.tagName}${Array.from(n.parentElement?.children ?? []).indexOf(n)}`);
      const name = (el.getAttribute("aria-label") || el.textContent || el.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);
      if (box.width < 2 || box.height < 2) return { key: path.join("/"), name, covered: false };
      const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      return {
        key: path.join("/"),
        name,
        covered: !hit || !(hit === el || el.contains(hit) || hit.contains(el)),
      };
    });
    if (!r) break; // reached the top
    if (seen.has(r.key)) break;
    seen.add(r.key);
    if (r.covered) covered.push(r.name);
  }
  return covered;
}

for (const path of ["/", "/growth"]) {
  test(`Check 32 P3: Shift+Tab up ${path} never puts focus under a sticky bar`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    // Focus starts after the last element, so the first Shift+Tab lands on the page's last stop.
    await page.evaluate(() => {
      const end = document.createElement("span");
      end.tabIndex = 0;
      end.id = "sa-test-end";
      document.body.append(end);
      end.focus();
      end.addEventListener("blur", () => end.remove(), { once: true });
    });
    expect(await coveredWalkingUp(page)).toEqual([]);
  });
}

test("Check 32 P3: the homepage header can't take focus while the Growth bar covers it", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const header = page.locator("[data-site-header]");
  await expect(header).not.toHaveAttribute("inert");
  // Well into the Growth part: the bar is stuck to the top, over the header.
  await page.evaluate(() => {
    document.getElementById("growth")!.scrollIntoView();
    window.scrollBy(0, 400);
  });
  await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "growth");
  await expect(header).toHaveAttribute("inert", "");
  const focusable = await header.evaluate((h) =>
    Array.from(h.querySelectorAll<HTMLElement>("a, button")).filter((el) => {
      el.focus();
      return document.activeElement === el;
    }),
  );
  expect(focusable).toHaveLength(0);
  // Back up into the app part: the header works again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("html")).toHaveAttribute("data-sa-theme", "app");
  await expect(header).not.toHaveAttribute("inert");
});

/** WCAG contrast of two "rgb(r, g, b)" colours. */
function contrast(a: string, b: string) {
  const lum = (c: string) => {
    const [r, g, bl] = c
      .match(/\d+(\.\d+)?/g)!
      .slice(0, 3)
      .map(Number) as [number, number, number];
    const ch = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Keyboard-focus the element; the outline's colour against what's behind the element. */
async function ringContrast(page: Page, el: Locator) {
  await page.keyboard.press("Shift"); // a key press first, so focus() counts as keyboard focus
  await el.focus();
  const c = await el.evaluate((node) => {
    const style = getComputedStyle(node);
    let bg = "rgba(0, 0, 0, 0)";
    for (let n = node.parentElement; n; n = n.parentElement) {
      const b = getComputedStyle(n).backgroundColor;
      if (b && !b.startsWith("rgba(0, 0, 0, 0)") && b !== "transparent") {
        bg = b;
        break;
      }
    }
    if (bg.startsWith("rgba(0, 0, 0, 0)")) bg = getComputedStyle(document.body).backgroundColor;
    return {
      visible: node.matches(":focus-visible"),
      outline: style.outlineColor,
      width: parseFloat(style.outlineWidth),
      style: style.outlineStyle,
      bg,
    };
  });
  expect(c.visible).toBe(true);
  expect(c.style).toBe("solid");
  expect(c.width).toBeGreaterThanOrEqual(2);
  return contrast(c.outline, c.bg);
}

test("Check 32 P4: inverted chips and buttons on paper show a 3:1 focus ring", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "keyboard focus check");
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, { status: "evaluating" });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ body: "Hey Priya,\n\nWe can come by at {{time}}.\n\nThanks, Davi" })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  for (const sunlight of [false, true]) {
    if (sunlight)
      await context.addCookies([
        { name: "sa_contrast", value: "high", domain: "localhost", path: "/" },
      ]);
    const where = (what: string) => `${what} sunlight=${sunlight}`;

    await page.goto("/queue");
    const gap = page.getByRole("button", { name: "Fill in time" });
    expect(await ringContrast(page, gap), where("gap chip")).toBeGreaterThanOrEqual(3);
    const step = page
      .getByRole("region", { name: "Getting started" })
      .locator("a.sa-inverted")
      .first();
    expect(await ringContrast(page, step), where("next step")).toBeGreaterThanOrEqual(3);
    if (sunlight) {
      const sun = page.getByRole("button", { name: "Sunlight" });
      await expect(sun).toHaveAttribute("aria-pressed", "true");
      expect(await ringContrast(page, sun), where("Sunlight")).toBeGreaterThanOrEqual(3);
    }

    await page.goto("/quotes");
    const open = page.getByRole("link", { name: /^Open/ }).and(page.locator(".sa-inverted"));
    expect(await ringContrast(page, open), where("Quotes filter")).toBeGreaterThanOrEqual(3);

    await page.goto("/queue/review?cat=quote_request");
    const chip = page
      .getByRole("navigation", { name: "Which kinds" })
      .locator("a.sa-inverted")
      .first();
    expect(await ringContrast(page, chip), where("review chip")).toBeGreaterThanOrEqual(3);
  }
});
