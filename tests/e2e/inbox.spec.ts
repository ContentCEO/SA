import { expect, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

async function seedThreads(mailboxId: string) {
  const rows = [
    {
      g: "a",
      category: "scheduling",
      summary: "Marco wants to move rough-in to Thursday.",
      needsOwner: false,
      from: "Marco",
    },
    {
      g: "b",
      category: "complaint",
      summary: "Dana says the breaker keeps tripping since the panel swap.",
      needsOwner: true,
      reason: "Complaint — you'll want to handle this yourself.",
      from: "Dana",
    },
    {
      g: "c",
      category: "quote_request",
      summary: "Priya wants a quote for a water heater swap.",
      needsOwner: false,
      from: "Priya",
    },
  ];
  for (const r of rows) {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId,
        gmailThreadId: `${r.g}-${mailboxId}`,
        inInbox: true,
        category: r.category,
        summary: r.summary,
        needsOwner: r.needsOwner,
        needsOwnerReason: r.reason ?? null,
        lastMessageAt: new Date(),
        subject: `Subject ${r.g}`,
        extracted: { service_requested: "panel upgrade", dates: ["Thursday"], dollar_amounts: [] },
      })
      .returning();
    await testDb.insert(schema.messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `m-${r.g}-${mailboxId}`,
      direction: "in",
      fromName: r.from,
      fromAddress: `${r.from.toLowerCase()}@example.com`,
      sentAt: new Date(),
    });
  }
}

test("inbox shows sorted mail, needs-me first, and filters by category", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  await signInAs(context, owner);

  await page.goto("/inbox");
  const items = page.locator("main li");
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("Dana");
  await expect(items.first()).toContainText("Needs you");

  await page.getByRole("link", { name: "Scheduling" }).click();
  await expect(page).toHaveURL(/c=scheduling/);
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("move rough-in to Thursday");

  await page.getByRole("link", { name: "Needs me" }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Dana");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("'This one needs me' moves a thread into Needs me", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  await signInAs(context, owner);

  await page.goto("/inbox?c=quote_request");
  await page.getByText("Priya", { exact: true }).click();
  await expect(page.getByText("Work")).toBeVisible();
  await page.getByRole("button", { name: "This one needs me" }).click();

  await page.goto("/inbox?c=needs_me");
  await expect(page.locator("main li")).toHaveCount(2);
  await expect(page.getByText("Priya", { exact: true })).toBeVisible();
});
