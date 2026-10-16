import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedOwner, seedQueue, setWorkspace, signInAs } from "./support";

test("installable: manifest opens on the queue, full screen, with real icons", async ({
  request,
}) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({
    name: "Squared Away",
    start_url: "/queue",
    display: "standalone",
    theme_color: "#1B1B1B",
  });
  for (const icon of m.icons as { src: string; sizes: string }[]) {
    const img = await request.get(icon.src);
    expect(img.ok(), icon.src).toBe(true);
    expect(img.headers()["content-type"]).toContain("image/png");
  }
  expect((await request.get("/app-icon/apple-180")).ok()).toBe(true);
  expect((await request.get("/app-icon/nope")).status()).toBe(404);
});

test("service worker is always fresh, and the offline page explains plainly", async ({
  request,
}) => {
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["cache-control"]).toContain("no-cache");
  const swText = await sw.text();
  expect(swText).toContain("never caches pages or");
  // Plan #34: a notification tap opens the link it carries (allow-listed), not always /queue.
  expect(swText).toContain("notification.data");
  // Plan #38: a push also updates the number on the home-screen icon.
  expect(swText).toContain("setAppBadge");
  const offline = await request.get("/offline.html");
  expect(await offline.text()).toContain("nothing lost.");
});

test("settings shows how to get the app", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/settings");
  await page.getByRole("link", { name: /^This phone/ }).click();
  await expect(page).toHaveURL(/\/settings\/phone$/);
  const section = page.getByRole("region", { name: "Get the app" });
  await expect(section).toContainText("Put Squared Away on your home screen");
  await expect(section).toContainText(/Install|Add to Home Screen/);
});

/** Stand-ins for the Badging API that record every call in `window.__badge`. */
async function recordBadge(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __badge: [string, number?][] };
    w.__badge = [];
    Object.defineProperty(Navigator.prototype, "setAppBadge", {
      configurable: true,
      value: async (n?: number) => void w.__badge.push(["set", n]),
    });
    Object.defineProperty(Navigator.prototype, "clearAppBadge", {
      configurable: true,
      value: async () => void w.__badge.push(["clear"]),
    });
  });
}
const lastBadge = (page: Page) =>
  page.evaluate(() => (window as unknown as { __badge: [string, number?][] }).__badge.at(-1));

test("home-screen badge: replies + needs-you on the queue, cleared once signed out", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true });
  await seedQueue(owner.mailboxId!); // 1 needs-you + 1 reply ready
  await signInAs(context, owner);
  await recordBadge(page);

  await page.goto("/queue");
  await expect.poll(() => lastBadge(page)).toEqual(["set", 2]);

  // Signed out (A31: the cookie gone, so /signin doesn't bounce back to the queue).
  await context.clearCookies();
  await page.goto("/signin");
  await expect.poll(() => lastBadge(page)).toEqual(["clear"]);
});

test("home-screen badge: a read-only account's badge clears", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await seedQueue(owner.mailboxId!);
  await setWorkspace(owner.workspaceId, { status: "past_due" });
  await signInAs(context, owner);
  await recordBadge(page);

  await page.goto("/queue");
  await expect.poll(() => lastBadge(page)).toEqual(["clear"]);
  const calls = await page.evaluate(
    () => (window as unknown as { __badge: [string, number?][] }).__badge,
  );
  expect(calls.some(([kind]) => kind === "set")).toBe(false);
});
