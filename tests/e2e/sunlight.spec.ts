import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

test("sunlight mode: one tap, no server call, remembered on this device, nothing spills off screen", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");

  // Check 8 P4: the tap changes the screen itself — no POST, no refresh.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  const toggle = page.getByRole("button", { name: "Sunlight" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
  expect(posts).toEqual([]);
  const cookie = (await context.cookies()).find((c) => c.name === "sa_contrast");
  expect(cookie?.value).toBe("high");
  expect(cookie?.httpOnly).toBe(false);

  // A reload keeps it (the server reads the cookie: right look on the first paint).
  await page.reload();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sunlight" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goto("/settings");
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  for (const path of ["/queue", "/settings", "/settings/phone", "/more"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, path).toBe(false);
  }

  // A second tap turns it off, and that sticks too.
  await page.getByRole("button", { name: "Sunlight" }).click();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sunlight" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(posts).toEqual([]);
  await page.reload();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(0);
});

test("Check 8 P4: Sunlight works with no signal", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Sunlight" }).click();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  await expect(page.getByText("something broke")).toHaveCount(0);
  // Not stopped by the no-signal guard either: nothing to send.
  await expect(page.getByText("Nothing was sent or changed.")).toHaveCount(0);
  await context.setOffline(false);
});

test("Check 8 P4: after a Sunlight tap the other tabs still open at once", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Sunlight" }).click();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  // A slow signal from here on: the Inbox's data takes 3 seconds.
  await page.route("**/inbox**", async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page
    .getByRole("navigation", { name: "Main" })
    .filter({ visible: true })
    .getByRole("link", { name: "Inbox" })
    .click();
  await expect(page.getByRole("status", { name: "Loading" })).toBeVisible({ timeout: 500 });
  await expect(page.locator("[data-updated-at]")).toBeVisible({ timeout: 10_000 });
});

const DAY = 86_400_000;

/** An invoice thread on /money: owed, paid by the owner, or hidden as "Not owed to me". */
async function moneyRow(
  mailboxId: string,
  name: string,
  amount: number,
  state: "owed" | "paid" | "hidden",
) {
  const gid = `sweep-${randomUUID().slice(0, 8)}`;
  const address = `${name.split(" ")[0]!.toLowerCase()}@customer.com`;
  const now = Date.now();
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: "invoice_payment",
      summary: `${name} asks about the invoice.`,
      lastMessageAt: new Date(now - 2 * DAY),
      extracted: {
        invoice: {
          invoice_number: `INV-${gid.slice(-4)}`,
          amount,
          due_date: new Date(now - 9 * DAY).toISOString().slice(0, 10),
          status: "unpaid",
        },
        invoice_thread: true,
      },
      ...(state === "paid"
        ? { invoicePaidAt: new Date(now - DAY), invoicePaidSource: "owner" as const }
        : state === "hidden"
          ? { invoicePaidAt: new Date(now - DAY), invoicePaidSource: "not_owed" as const }
          : {}),
    })
    .returning();
  await testDb.insert(schema.messages).values([
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromAddress: address,
      fromName: name,
      toAddresses: ["owner@example.com"],
      bodyText: "Got the invoice, thanks.",
      sentAt: new Date(now - 3 * DAY),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-out`,
      direction: "out",
      fromAddress: "owner@example.com",
      toAddresses: [address],
      bodyText: "Invoice attached.",
      sentAt: new Date(now - 2 * DAY),
    },
  ]);
}

/** Every visible control inside <main> that's smaller than 44×44, described for the failure. */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = "main a, main button, main select, main input:not([type=hidden]), main summary";
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
      .map(({ el, r }) => `${el.tagName} "${el.textContent?.trim()}" ${r.width}x${r.height}`);
  });
}

test("money owed at 375px: every control is a 44px target and nothing spills, in both modes", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  // Sam's paid row carries "Say thanks" into the sweep (2026-10-16).
  await testDb
    .insert(schema.businessProfiles)
    .values({ workspaceId: owner.workspaceId, reviewUrl: "https://g.page/r/sweep-test/review" });
  await moneyRow(owner.mailboxId!, "Dana Ruiz-Featherstonehaugh", 12_400, "owed");
  await moneyRow(owner.mailboxId!, "Sam Lee", 300, "paid");
  await moneyRow(owner.mailboxId!, "Kim Park", 800, "hidden");
  await signInAs(context, owner);

  for (const sunlight of [false, true]) {
    if (sunlight) {
      await page.getByRole("button", { name: "Sunlight" }).click();
      await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
    }
    for (const path of ["/money", "/money?show=hidden"]) {
      await page.goto(path);
      await expect(page.getByRole("region", { name: "Owed to you", exact: true })).toBeVisible();
      await expect(
        page.getByRole("article", { name: "Dana Ruiz-Featherstonehaugh" }),
      ).toBeVisible();
      if (path.endsWith("hidden")) {
        await expect(page.getByRole("region", { name: "Not owed to you" })).toContainText(
          "Kim Park",
        );
      } else {
        const paid = page.getByRole("region", { name: "Paid in the last 30 days" });
        await expect(paid).toContainText("Sam Lee");
        await expect(paid.getByRole("button", { name: "Say thanks" })).toBeVisible();
      }
      expect(await smallTargets(page), `${path} sunlight=${sunlight}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow, `${path} sunlight=${sunlight}`).toBe(false);
    }
  }
});

/** Check 7 P2: sunlight's heavier weights really render (they need the 100–900 face). */
test("sunlight: 500 is heavier than 400, and semibold is lighter than black", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "phone check");
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await context.addCookies([
    { name: "sa_contrast", value: "high", domain: "localhost", path: "/" },
  ]);
  await page.goto("/queue");
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const widths = await page.evaluate(async () => {
    const app = document.getElementById("sa-app")!;
    const span = (style: string, cls = "") => {
      const s = document.createElement("span");
      s.textContent = "Question · Needs you · Waiting on you";
      s.setAttribute("style", `position:absolute;white-space:nowrap;font-size:40px;${style}`);
      s.className = cls;
      app.append(s);
      return s;
    };
    const w400 = span("font-weight:400");
    const w500 = span("font-weight:500");
    const semibold = span("", "font-semibold");
    const black = span("", "font-black");
    await document.fonts.ready;
    const w = (el: HTMLElement) => el.getBoundingClientRect().width;
    return { w400: w(w400), w500: w(w500), semibold: w(semibold), black: w(black) };
  });
  expect(widths.w500).toBeGreaterThan(widths.w400 + 1);
  expect(widths.black).toBeGreaterThan(widths.semibold + 1);
});
