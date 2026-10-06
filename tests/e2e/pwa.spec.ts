import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

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
  expect(await sw.text()).toContain("never caches pages or");
  const offline = await request.get("/offline.html");
  expect(await offline.text()).toContain("nothing lost.");
});

test("settings shows how to get the app", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Get the app" });
  await expect(section).toContainText("Put Squared Away on your home screen");
  await expect(section).toContainText(/Install|Add to Home Screen/);
});
