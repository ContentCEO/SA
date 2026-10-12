import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
/** YYYY-MM-DD, `d` days ago (UTC; the assertions allow a day either way for the owner's zone). */
const dateAgo = (d: number) => ago(d).toISOString().slice(0, 10);

async function invoice(
  mailboxId: string,
  o: { name: string; from: string; amount: number; dueDaysAgo: number; number?: string },
) {
  const gid = `inv-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: "invoice_payment",
      summary: `${o.name} asks about the invoice.`,
      lastMessageAt: ago(3),
      extracted: {
        invoice: {
          invoice_number: o.number ?? null,
          amount: o.amount,
          due_date: dateAgo(o.dueDaysAgo),
          status: "unpaid",
        },
        invoice_thread: true,
      },
    })
    .returning();
  await testDb.insert(schema.messages).values([
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromAddress: o.from,
      fromName: o.name,
      bodyText: "Got the invoice, thanks.",
      sentAt: ago(5),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-out`,
      direction: "out",
      fromAddress: "owner@example.com",
      bodyText: "Invoice attached.",
      sentAt: ago(3),
    },
  ]);
}

test("money owed: from Quotes, mark paid, undo, and hide one that isn't owed", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await invoice(owner.mailboxId!, {
    name: "Dana Ruiz",
    from: "dana@customer.com",
    amount: 1200,
    dueDaysAgo: 10,
    number: "INV-1042",
  });
  await invoice(owner.mailboxId!, {
    name: "Sam Lee",
    from: "sam@customer.com",
    amount: 300,
    dueDaysAgo: -20,
  });
  await signInAs(context, owner);

  await page.goto("/quotes");
  await page.getByRole("link", { name: "Money owed →" }).click();
  await expect(page).toHaveURL(/\/money$/);
  await expect(page.getByRole("region", { name: "Owed to you" })).toContainText("$1,500");

  const owed = page.getByRole("list", { name: "Invoices still owed" });
  // Oldest due first: Dana's (past due) on top.
  await expect(owed.getByRole("article").first()).toHaveAccessibleName("Dana Ruiz");
  const dana = page.getByRole("article", { name: "Dana Ruiz" });
  await expect(dana).toContainText("$1,200");
  await expect(dana).toContainText(/\d+ days past due/);
  await expect(dana).toContainText("Invoice INV-1042");
  await expect(dana).toContainText("Nudges used: 0 of 2");
  await expect(page.getByRole("article", { name: "Sam Lee" })).toContainText("Not due yet");

  await dana.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked paid" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Dana Ruiz" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Owed to you" })).toContainText("$300");
  const paid = page.getByRole("region", { name: "Paid in the last 30 days" });
  await expect(paid).toContainText("Dana Ruiz");
  await expect(paid).toContainText("$1,200");

  await paid.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Back on the list." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Dana Ruiz" })).toContainText("$1,200");
  await expect(page.getByRole("region", { name: "Paid in the last 30 days" })).toHaveCount(0);

  // Not owed to me → hidden, and Put back from the hidden list.
  await page
    .getByRole("article", { name: "Sam Lee" })
    .getByRole("button", { name: "Not owed to me" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Hidden." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Sam Lee" })).toHaveCount(0);
  await page.getByRole("link", { name: "Hidden (1)" }).click();
  const hidden = page.getByRole("region", { name: "Not owed to you" });
  await expect(hidden).toContainText("Sam Lee");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await hidden.getByRole("button", { name: "Put back" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Put back on the list." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Sam Lee" })).toBeVisible();

  // Activity says it in plain words, and links back here.
  await page.goto("/activity");
  await expect(page.getByText("You marked Dana's invoice paid")).toBeVisible();
  await expect(page.getByText("You put Dana's invoice back on the owed list")).toBeVisible();
  await page.getByRole("link", { name: "Money owed →" }).click();
  await expect(page).toHaveURL(/\/money$/);
});

test("money owed: empty, and read-only accounts can look but not mark", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/money");
  await expect(
    page.getByText("Nothing owed that we can see. Invoices show up here when a customer email"),
  ).toBeVisible();

  await invoice(owner.mailboxId!, {
    name: "Kim Park",
    from: "kim@customer.com",
    amount: 800,
    dueDaysAgo: 4,
  });
  await testDb
    .update(schema.workspaces)
    .set({ status: "evaluation_expired" })
    .where(eq(schema.workspaces.id, owner.workspaceId));
  await page.goto("/money");
  const kim = page.getByRole("article", { name: "Kim Park" });
  await expect(kim).toContainText("$800");
  await expect(kim.getByRole("button", { name: "Mark paid" })).toHaveCount(0);
  await expect(kim.getByRole("button", { name: "Not owed to me" })).toHaveCount(0);
});
