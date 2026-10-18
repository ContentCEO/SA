import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

test("sunlight mode: one tap, remembered on this device, nothing spills off screen", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");

  const toggle = page.getByRole("button", { name: "Sunlight" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await toggle.click();
  await expect(page.getByRole("button", { name: "Sunlight" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));

  await page.goto("/settings");
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(1);
  for (const path of ["/queue", "/settings", "/settings/phone", "/more"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, path).toBe(false);
  }

  await page.getByRole("button", { name: "Sunlight" }).click();
  await expect(page.locator('[data-contrast="high"]')).toHaveCount(0);
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
