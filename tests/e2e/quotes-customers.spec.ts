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

  await sam.getByText("Mark how it ended").click();
  await sam.getByLabel("Job amount (optional)").fill("1350");
  await sam.getByRole("button", { name: "Mark won" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked won" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Quote for Sam Lee" })).toHaveCount(0);

  await page.getByRole("link", { name: /^Won \(1\)/ }).click();
  await expect(page.getByRole("article", { name: "Quote for Sam Lee" })).toContainText("$1,350");
  await expect(page.getByRole("region", { name: "Last 30 days" })).toContainText("$1,350");
});

test("quotes: no answer is our guess, one tap changes it, and Activity shows the close rate", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  // Quoted 25 days ago, never heard back → we guess "no answer" when Quotes loads.
  await quote(owner.mailboxId!, {
    name: "Kim Park",
    from: "kim@customer.com",
    inAgo: 26,
    outAgo: 25,
    reply: "Hi Kim, the deck repair is $3,100.",
    summary: "Kim wants a deck repair.",
  });
  await quote(owner.mailboxId!, {
    name: "Lee Chan",
    from: "lee@customer.com",
    inAgo: 3,
    outAgo: 2,
    summary: "Lee wants a faucet swapped.",
  });
  await signInAs(context, owner);

  await page.goto("/quotes");
  await page.getByRole("link", { name: /^No answer \(1\)/ }).click();
  await expect(page).toHaveURL(/stage=no_answer/);
  const kim = page.getByRole("article", { name: "Quote for Kim Park" });
  await expect(kim).toContainText("No answer (our guess)");

  // Our guess was wrong: one tap.
  await kim.getByRole("button", { name: "Mark won", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked won" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Quote for Kim Park" })).toHaveCount(0);
  await page.getByRole("link", { name: /^Won \(1\)/ }).click();
  const kimWon = page.getByRole("article", { name: "Quote for Kim Park" });
  await expect(kimWon).toContainText("Won");
  await expect(kimWon).not.toContainText("our guess");
  await expect(kimWon.getByRole("button", { name: "Mark no answer" })).toBeVisible();
  await expect(kimWon.getByRole("button", { name: "Reopen" })).toBeVisible();

  // The third outcome on an open quote.
  await page.getByRole("link", { name: /^Open \(1\)/ }).click();
  const lee = page.getByRole("article", { name: "Quote for Lee Chan" });
  await lee.getByText("Mark how it ended").click();
  await lee.getByRole("button", { name: "No answer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked no answer." })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await page.goto("/activity");
  const close = page.getByRole("region", { name: "Quotes decided this month" });
  await expect(close).toContainText("You won 1 of 2 quotes decided this month (50%).");
  await expect(close.getByRole("link", { name: "Go to Quotes" })).toBeVisible();
  await expect(
    page.getByText(
      "Marked a quote from Kim as no answer after three quiet weeks. Change it on Quotes",
    ),
  ).toBeVisible();
  await expect(page.getByText("You marked a quote from Kim as won")).toBeVisible();
  await expect(page.getByText("You marked a quote from Lee as no answer")).toBeVisible();
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

  // Five tabs: Customers is under More.
  await page.goto("/queue");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "More" }).click();
  await page
    .getByRole("navigation", { name: "More" })
    .getByRole("link", { name: /^Customers/ })
    .click();
  await expect(page).toHaveURL(/\/customers$/);
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

test("customers: suppliers and towns are kept apart under their own links", async ({
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
  for (const [name, from, category] of [
    ["Supply House Branch 42", "branch42@supplyhouse.com", "supplier_vendor"],
    ["Chelmsford Building Dept", "inspections@chelmsfordma.gov", "scheduling"],
  ] as const) {
    const gid = `k-${randomUUID().slice(0, 8)}`;
    const [t] = await testDb
      .insert(schema.threads)
      .values({ mailboxId: owner.mailboxId!, gmailThreadId: gid, inInbox: true, category })
      .returning();
    await testDb.insert(schema.messages).values({
      threadId: t!.id,
      mailboxId: owner.mailboxId!,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromAddress: from,
      fromName: name,
      bodyText: "Hello",
      sentAt: ago(1),
    });
  }
  await signInAs(context, owner);

  await page.goto("/customers");
  await expect(page.getByText("Suppliers, towns and your crew are kept apart.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Priya Shah/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Supply House/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Chelmsford/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Towns and inspectors (1)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Your crew and subs (0)" })).toBeVisible();
  const suppliers = page.getByRole("link", { name: "Suppliers (1)" });
  expect((await suppliers.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await suppliers.click();
  await expect(page).toHaveURL(/\/customers\?group=suppliers$/);
  await expect(page.getByRole("link", { name: /Supply House Branch 42/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Priya Shah/ })).toHaveCount(0);
});

test("a junk email's id is not a customer page (Check 13 P2)", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const gid = `j-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({ mailboxId: owner.mailboxId!, gmailThreadId: gid, inInbox: true, category: "noise" })
    .returning();
  const [m] = await testDb
    .insert(schema.messages)
    .values({
      threadId: t!.id,
      mailboxId: owner.mailboxId!,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromAddress: "deals@shop-sale.com",
      fromName: "Deals",
      bodyText: "Sale",
      sentAt: ago(1),
    })
    .returning();
  await signInAs(context, owner);
  const res = await page.goto(`/customers/${m!.id}`);
  expect(res?.status()).toBe(404);
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
