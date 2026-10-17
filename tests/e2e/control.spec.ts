import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

/** Ideas H3 / H4 / G7 / E7: the owner's own controls. */
async function email(
  mailboxId: string,
  o: { from: string; name: string; category: string; summary: string },
) {
  const gid = `c-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: o.category,
      summary: o.summary,
      classifiedAt: new Date(),
      lastMessageAt: new Date(),
    })
    .returning();
  const [m] = await testDb
    .insert(schema.messages)
    .values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromAddress: o.from,
      fromName: o.name,
      replyToHeader: {},
      subject: o.summary,
      bodyText: "Hello",
      sentAt: new Date(Date.now() - 3_600_000),
    })
    .returning();
  return { threadId: t!.id, messageId: m!.id };
}

test("sender rule, move it, private note", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await email(owner.mailboxId!, {
    from: "deals@toolmart.com",
    name: "Tool Mart",
    category: "supplier_vendor",
    summary: "Weekly tool deals.",
  });
  const dana = await email(owner.mailboxId!, {
    from: "dana@customer.com",
    name: "Dana Ruiz",
    category: "quote_request",
    summary: "Dana wants a water heater quote.",
  });
  await signInAs(context, owner);

  // H3: Always junk for one address.
  await page.goto("/inbox");
  const row = page.locator("li", { hasText: "Weekly tool deals." });
  await row.locator("summary").first().click();
  await row.locator("summary", { hasText: "Rules for this sender" }).click();
  await row.getByLabel(/Always junk/).check();
  await row.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("Rule saved. It applies to new email from now on.")).toBeVisible();
  await page.goto("/settings/sender-rules");
  await expect(page.getByText("deals@toolmart.com")).toBeVisible();
  await page.getByText("Remove", { exact: true }).click();
  await page.getByRole("button", { name: "Remove rule" }).click();
  await expect(page.getByText("Rule removed.")).toBeVisible();

  // H4: move a quote request to Supplier.
  await page.goto("/inbox");
  const danaRow = page.locator("li", { hasText: "water heater quote" });
  await danaRow.locator("summary").first().click();
  await danaRow.locator("summary", { hasText: "Wrong kind? Move it" }).click();
  await danaRow.getByLabel("Supplier", { exact: true }).check();
  await danaRow.getByRole("button", { name: "Move it" }).click();
  await expect(page.getByText("Moved to Suppliers.")).toBeVisible();
  const [t] = await testDb
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, dana.threadId));
  expect(t!.categoryManual).toBe("supplier_vendor");

  // G7: a private note on the customer page, shown on their Inbox row.
  await page.goto(`/customers/${dana.messageId}`);
  await page.locator("textarea[name=note]").fill("Gate code 4411, big dog");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Note saved.")).toBeVisible();
  await page.goto("/inbox");
  await page.locator("li", { hasText: "water heater quote" }).locator("summary").first().click();
  await expect(page.getByText("Gate code 4411, big dog")).toBeVisible();
  expect(await page.locator("[aria-label*='Gate code']").count()).toBe(0);
});

test("away mode: on, queue line, off", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/settings/away");
  const back = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("I'm back on").fill(back);
  await page.getByRole("button", { name: "Turn on away mode" }).click();
  await expect(page.getByText("Away mode is on.")).toBeVisible();
  await page.goto("/queue");
  await expect(page.getByText(/Away mode is on until .*Follow-ups are paused\./)).toBeVisible();
  const off = page.getByRole("button", { name: "Turn off away mode" });
  expect((await off.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await off.click();
  await expect(page.getByText("Welcome back. Away mode is off.")).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Away mode\s*Off/ })).toBeVisible();
});
