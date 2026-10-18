import { expect, type Page, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

/**
 * Phone look and accessibility (wave 2). The bottom tab bar is fixed on phones; these check it
 * never hides what the owner is working on.
 */

/** An owner with a queue, replies in Activity and a quote, so every screen scrolls. */
async function busyOwner() {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft, quote } = await seedQueue(owner.mailboxId!);
  await testDb.insert(schema.activityLog).values(
    Array.from({ length: 6 }, () => ({
      workspaceId: owner.workspaceId,
      actor: "owner" as const,
      action: "reply_sent",
      threadId: quote.t.id,
      detail: { draftId: draft.id, editedByOwner: false, kind: "reply" },
    })),
  );
  return owner;
}

/**
 * Tab through every focusable item; for each one, the item's box must not lie fully inside the
 * tab bar's box (WCAG 2.2 2.4.11). Items inside the bar are the bar's own links.
 */
async function hiddenByTabBar(page: Page) {
  const hidden: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const bar = document.querySelector("[data-tabbar]");
      if (!el || el === document.body || !bar) return null;
      const a = el.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const name = (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.getAttribute("name") ||
        el.tagName
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);
      const path: string[] = [];
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement)
        path.push(`${n.tagName}${Array.from(n.parentElement?.children ?? []).indexOf(n)}`);
      return {
        key: path.join("/"),
        name,
        inBar: bar.contains(el),
        covered:
          a.width > 0 &&
          a.top >= b.top &&
          a.bottom <= b.bottom &&
          a.left >= b.left &&
          a.right <= b.right,
      };
    });
    if (!r) continue;
    if (seen.has(r.key)) break; // wrapped around
    seen.add(r.key);
    if (!r.inBar && r.covered) hidden.push(r.name);
  }
  return hidden;
}

test("Check 32 P2: Tab never puts focus behind the phone tab bar", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "the tab bar shows on phones only");
  const owner = await busyOwner();
  await signInAs(context, owner);
  for (const path of ["/queue", "/activity", "/quotes", "/settings/profile"]) {
    await page.goto(path);
    await expect(page.locator("[data-tabbar]")).toBeVisible();
    expect(await hiddenByTabBar(page), path).toEqual([]);
  }
});

test("Check 8 P2: the page covers the whole screen and pads for the tab bar", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "the tab bar shows on phones only");
  await page.setViewportSize({ width: 375, height: 812 });
  const owner = await busyOwner();
  await signInAs(context, owner);
  await page.goto("/queue");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("viewport-fit=cover");

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const box = await page.evaluate(() => {
    const bar = document.querySelector("[data-tabbar]")!.getBoundingClientRect();
    const app = document.getElementById("sa-app")!;
    // The wrapper's last visible child (the footer) ends above the bar.
    const kids = Array.from(app.children).filter(
      (el) => !el.matches("[data-tabbar]") && el.getBoundingClientRect().height > 0,
    );
    const last = kids[kids.length - 1]!.getBoundingClientRect();
    return { barTop: bar.top, barBottom: bar.bottom, lastBottom: last.bottom, vh: innerHeight };
  });
  expect(box.barBottom).toBe(box.vh);
  expect(box.lastBottom).toBeLessThanOrEqual(box.barTop);
});

/** Pretend the app went to the background (or came back), as a phone does. */
async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** Moves the page's clock forward (Date.now only; timers keep running). */
async function skipAhead(page: Page, ms: number) {
  await page.evaluate((by) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + by;
  }, ms);
}

/** Counts RSC (router) requests for a path from now on. */
function rscCounter(page: Page, pathname: string) {
  const hits: string[] = [];
  page.on("request", (req) => {
    if (req.headers()["rsc"] === "1" && new URL(req.url()).pathname === pathname)
      hits.push(req.url());
  });
  return hits;
}

test("Check 8 P3: back after a minute refreshes the queue, but never mid-edit", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  const hits = rscCounter(page, "/queue");

  // A quick look away: nothing.
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await page.waitForTimeout(500);
  expect(hits).toHaveLength(0);

  // Away for 61 seconds: one fresh fetch of the queue.
  await setVisibility(page, "hidden");
  await skipAhead(page, 61_000);
  await setVisibility(page, "visible");
  await expect.poll(() => hits.length).toBe(1);

  // Edit open on a card (focus moved off the box): no refresh, the edit stays.
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Your reply").fill("Hey Priya, still typing");
  await page.locator("h1").first().click();
  await setVisibility(page, "hidden");
  await skipAhead(page, 61_000);
  await setVisibility(page, "visible");
  await page.waitForTimeout(1500);
  expect(hits).toHaveLength(1);
  await expect(card.getByLabel("Your reply")).toHaveValue("Hey Priya, still typing");
});

test("Check 8 P3: tapping the tab you're on goes to the top and refreshes", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  // Room to scroll 3,000px.
  await page.evaluate(() => {
    const pad = document.createElement("div");
    pad.style.height = "4000px";
    document.querySelector("main")!.append(pad);
    window.scrollTo(0, 3000);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3000);
  const hits = rscCounter(page, "/queue");
  await page
    .getByRole("navigation", { name: "Main" })
    .filter({ visible: true })
    .getByRole("link", { name: "Queue" })
    .click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => hits.length).toBeGreaterThanOrEqual(1);
  await expect(page).toHaveURL(/\/queue$/);
});

test("Check 8 P3: every tab screen says when it was updated", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  for (const path of ["/queue", "/inbox", "/quotes", "/money"]) {
    await page.goto(path);
    await expect(page.locator("[data-updated-at]"), path).toHaveText(
      /^Updated \d{1,2}:\d{2} [AP]M$/,
    );
  }
  // With no signal, the line says how old the list is.
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await expect(page.locator("[data-updated-at]")).toHaveText(
    /^No signal\. This is your queue from \d{1,2}:\d{2} [AP]M\.$/,
  );
  await context.setOffline(false);
});
