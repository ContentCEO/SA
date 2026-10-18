import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

/**
 * Leads package: the emergency lane with Call first, a lead website's card with its fixed
 * "Open <site>" link and no draft, a toll-free-only email with no Call row, and a fixed
 * complaint's check-in. Call / Text are plain tel: / sms: links from the owner's own phone.
 */
const DAY = 86_400_000;

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}
async function atLeast44(l: Locator) {
  const box = await l.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function seedThread(
  mailboxId: string,
  key: string,
  over: Partial<typeof schema.threads.$inferInsert>,
  msg: Partial<typeof schema.messages.$inferInsert>,
) {
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: `${key}-${mailboxId}`,
      inInbox: true,
      needsOwner: true,
      classifiedAt: new Date(),
      lastMessageAt: new Date(),
      ...over,
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m-${key}-${mailboxId}`,
    direction: "in",
    fromName: "Dana Ruiz",
    fromAddress: "dana@x.com",
    replyToHeader: {},
    subject: "Help",
    sentAt: new Date(Date.now() - 60_000),
    ...msg,
  });
  return t!;
}

test("emergency first with Call now; a Thumbtack lead opens Thumbtack; Done clears it", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const mb = owner.mailboxId!;
  const sos = await seedThread(
    mb,
    "sos",
    {
      category: "customer_question",
      priority: "high",
      needsOwnerReason: "Sounds like an emergency — call them if you can.",
      summary: "Water coming through the kitchen ceiling.",
      extracted: { urgency: "emergency", owner_rule_hits: ["emergency"] },
    },
    { bodyText: "Water everywhere! Call me 978-201-9763" },
  );
  const tt = await seedThread(
    mb,
    "tt",
    {
      category: "quote_request",
      leadChannel: "thumbtack",
      needsOwnerReason: "Came through Thumbtack — answer them there.",
      summary: "Wants a kitchen faucet replaced.",
    },
    {
      fromName: "Thumbtack",
      fromAddress: "no-reply@thumbtack.com",
      bodyText:
        "You have a new lead\nCustomer: Sam L.\nService: Faucet repair\nLocation: Lowell, MA\nNeed help? Call 978-201-1111",
    },
  );
  const tollFree = await seedThread(
    mb,
    "tf",
    { category: "quote_request", needsOwnerReason: "New customer asking about a big job." },
    { fromAddress: "pat@x.com", fromName: "Pat Doe", bodyText: "Call us 800-555-1234" },
  );
  await signInAs(context, owner);
  await page.goto("/queue");

  const lane = page.getByRole("region", { name: "Emergency" });
  const sosCard = lane.locator(`#t-${sos.id}`);
  await expect(sosCard).toContainText("Emergency · Question");
  const call = sosCard.getByRole("link", { name: "Call Dana now" });
  await expect(call).toHaveAttribute("href", "tel:+19782019763");
  await atLeast44(call);
  const text = sosCard.getByRole("link", { name: "Text Dana" });
  await expect(text).toHaveAttribute(
    "href",
    `sms:+19782019763?&body=${encodeURIComponent("Hi Dana, I got your message.")}`,
  );
  await atLeast44(text);
  await expect(sosCard).toContainText("Calls and texts go from your own phone.");
  // The lane sits above Needs you.
  const laneBox = await lane.boundingBox();
  const needsBox = await page.getByRole("region", { name: "Needs you" }).boundingBox();
  expect(laneBox!.y).toBeLessThan(needsBox!.y);

  const ttCard = page.locator(`#t-${tt.id}`);
  await expect(ttCard).toContainText("Thumbtack lead · Quote request");
  await expect(ttCard).toContainText("Faucet repair · Lowell, MA");
  await expect(ttCard).toContainText("Sam L.");
  const open = ttCard.getByRole("link", { name: "Open Thumbtack" });
  await expect(open).toHaveAttribute("href", "https://www.thumbtack.com/");
  await atLeast44(open);
  await expect(ttCard.getByRole("button", { name: "Draft a reply" })).toHaveCount(0);
  // The site's own support line is never offered as the customer's number.
  await expect(ttCard.getByRole("link", { name: /^Call/ })).toHaveCount(0);

  await expect(page.locator(`#t-${tollFree.id}`)).toBeVisible();
  await expect(page.locator(`#t-${tollFree.id}`).getByRole("link", { name: /^Call/ })).toHaveCount(
    0,
  );
  await noHorizontalScroll(page);

  await ttCard.getByRole("button", { name: "Done — I answered" }).click();
  await ttCard.getByRole("button", { name: "Yes, done" }).click();
  await expect(page).toHaveURL(/done=done/);
  await expect(page.getByText("Marked done. It'll come back if they write again.")).toBeVisible();
  await expect(page.locator(`#t-${tt.id}`)).toHaveCount(0);
});

test("a fixed complaint comes back as a check-in; All good closes it", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const fixedAt = new Date(Date.now() - 3 * DAY);
  const t = await seedThread(
    owner.mailboxId!,
    "fix",
    {
      category: "complaint",
      needsOwnerReason: "Complaint — you'll want to handle this yourself.",
      summary: "The leak came back.",
      complaintFixedAt: fixedAt,
      handledOfflineAt: fixedAt,
    },
    { sentAt: new Date(Date.now() - 4 * DAY), bodyText: "It's leaking again. 978-201-9763" },
  );
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.locator(`#t-${t.id}`);
  await expect(card).toContainText("Check in · Complaint");
  await expect(card).toContainText("You marked this fixed on");
  await expect(card.getByRole("link", { name: "Call Dana first" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Call Dana" })).toHaveAttribute(
    "href",
    "tel:+19782019763",
  );
  await card.getByRole("button", { name: "All good" }).click();
  await expect(page).toHaveURL(/done=checkin_closed/);
  await expect(page.locator(`#t-${t.id}`)).toHaveCount(0);
  const [row] = await testDb.select().from(schema.threads).where(eq(schema.threads.id, t.id));
  expect(row!.complaintCheckinDoneAt).not.toBeNull();
});

test("a complaint: Call first and Mark fixed take it off the queue", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const t = await seedThread(
    owner.mailboxId!,
    "cmp",
    {
      category: "complaint",
      priority: "high",
      needsOwnerReason: "Complaint — you'll want to handle this yourself.",
      summary: "The leak came back.",
    },
    { bodyText: "It's leaking again, call me at (978) 201-9763" },
  );
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.locator(`#t-${t.id}`);
  await expect(card.getByRole("link", { name: "Call Dana first" })).toHaveAttribute(
    "href",
    "tel:+19782019763",
  );
  await card.getByRole("button", { name: "Mark fixed" }).click();
  await expect(page).toHaveURL(/done=fixed/);
  await expect(page.getByText("Marked fixed. I'll remind you to check in")).toBeVisible();
  await expect(page.locator(`#t-${t.id}`)).toHaveCount(0);
});
