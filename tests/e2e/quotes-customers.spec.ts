import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

async function quote(
  mailboxId: string,
  o: {
    name: string;
    from: string;
    inAgo: number;
    outAgo?: number;
    reply?: string;
    summary: string;
  },
) {
  const gid = `q-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: "quote_request",
      summary: o.summary,
      lastMessageAt: ago(Math.min(o.inAgo, o.outAgo ?? Infinity)),
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${gid}-in`,
    direction: "in",
    fromAddress: o.from,
    fromName: o.name,
    bodyText: "Can you quote it?",
    sentAt: ago(o.inAgo),
  });
  if (o.outAgo !== undefined) {
    await testDb.insert(schema.messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-out`,
      direction: "out",
      fromAddress: "owner@example.com",
      bodyText: o.reply ?? "Sure.",
      sentAt: ago(o.outAgo),
    });
  }
}

test("quotes: stages, amounts, and one-tap Won", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await quote(owner.mailboxId!, {
    name: "Dana Ruiz",
    from: "dana@customer.com",
    inAgo: 1,
    summary: "Dana wants a panel upgrade quote.",
  });
  await quote(owner.mailboxId!, {
    name: "Sam Lee",
    from: "sam@customer.com",
    inAgo: 9,
    outAgo: 8,
    reply: "Hi Sam, the vanity install is $1,200.",
    summary: "Sam wants a vanity installed.",
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Quotes" })
    .click();
  await expect(page).toHaveURL(/\/quotes$/);

  const dana = page.getByRole("article", { name: "Quote for Dana Ruiz" });
  await expect(dana).toContainText("Waiting on you");
  const sam = page.getByRole("article", { name: "Quote for Sam Lee" });
  await expect(sam).toContainText("Gone quiet");
  await expect(sam).toContainText("$1,200");

  await sam.getByText("Mark won or lost").click();
  await sam.getByLabel("Job amount (optional)").fill("1350");
  await sam.getByRole("button", { name: "Mark won" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked won" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Quote for Sam Lee" })).toHaveCount(0);

  await page.getByRole("link", { name: /^Won \(1\)/ }).click();
  await expect(page.getByRole("article", { name: "Quote for Sam Lee" })).toContainText("$1,350");
  await expect(page.getByRole("region", { name: "Last 30 days" })).toContainText("$1,350");
});

test("customers: list, search on the phone, and one customer's emails", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await quote(owner.mailboxId!, {
    name: "Priya Shah",
    from: "priya@customer.com",
    inAgo: 2,
    summary: "Priya wants a water heater swapped.",
  });
  await quote(owner.mailboxId!, {
    name: "Tom Baker",
    from: "tom@customer.com",
    inAgo: 3,
    summary: "Tom asks about a deck repair.",
  });
  await signInAs(context, owner);

  await page.goto("/customers");
  await expect(page.getByRole("link", { name: /Priya Shah/ })).toBeVisible();
  await page.getByLabel("Find a customer").fill("baker");
  await expect(page.getByRole("link", { name: /Priya Shah/ })).toHaveCount(0);
  await page.getByRole("link", { name: /Tom Baker/ }).click();
  await expect(page.getByText("Tom asks about a deck repair.")).toBeVisible();
  await expect(page.getByRole("link", { name: "tom@customer.com" })).toBeVisible();
  // The URL carries an opaque key, never the email address.
  expect(page.url()).not.toContain("tom@");
  expect(page.url()).toMatch(/\/customers\/[0-9a-f-]{36}$/);
});

test("another owner's customer link is a 404", async ({ page, context }) => {
  const a = await seedOwner({ mailbox: true, backfilled: true });
  await quote(a.mailboxId!, { name: "Ann", from: "ann@c.com", inAgo: 1, summary: "Ann." });
  const [m] = await testDb.select({ id: schema.messages.id }).from(schema.messages).limit(1);
  const b = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, b);
  const res = await page.goto(`/customers/${m!.id}`);
  expect(res?.status()).toBe(404);
});
