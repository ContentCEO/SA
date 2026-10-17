import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

/** Ideas C5 / K2 on Quotes. */
async function request(mailboxId: string, from: string, summary: string) {
  const gid = `n-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: "quote_request",
      summary,
      lastMessageAt: new Date(),
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${gid}-in`,
    direction: "in",
    fromAddress: from,
    fromName: "Customer",
    replyToHeader: {},
    bodyText: "Can you quote it?",
    sentAt: new Date(Date.now() - 2 * 86_400_000),
  });
}

test("why you lost it, and where your work comes from", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await request(owner.mailboxId!, "leads@mail.thumbtack.com", "Thumbtack lead for a deck.");
  await request(owner.mailboxId!, "dana@customer.com", "Dana wants a bathroom fan.");
  await signInAs(context, owner);
  await page.goto("/quotes");
  await expect(page.getByText("Where your work comes from")).toBeVisible();
  await expect(
    page.getByText("Thumbtack: 1 request. Tap Won on Quotes to count jobs you won here."),
  ).toBeVisible();
  // A lead site never reads "0 won" (we can't see those replies); email leads may.
  await expect(page.locator("li", { hasText: /^Thumbtack:.*\b0 won/ })).toHaveCount(0);
  await expect(page.getByText("Direct email: 1 request, 0 won.")).toBeVisible();

  const card = page.locator("article", { hasText: "bathroom fan" });
  await card.getByText("Mark how it ended").click();
  await card.getByRole("button", { name: "Mark lost" }).click();
  await expect(page.getByText(/Marked lost\. Why\?/)).toBeVisible();
  await page.goto("/quotes?stage=lost");
  const lost = page.locator("article", { hasText: "bathroom fan" });
  const price = lost.getByRole("button", { name: "Price" });
  expect((await price.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await price.click();
  await expect(page.getByText("Got it.")).toBeVisible();
  await expect(
    page.locator("article", { hasText: "bathroom fan" }).getByText("Lost: price"),
  ).toBeVisible();
  await page.goto("/activity");
  await expect(page.getByText("Lost this month: 1 on price.")).toBeVisible();
});
