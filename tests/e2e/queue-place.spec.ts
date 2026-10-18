import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, setWorkspace, signInAs, testDb } from "./support";

/** Check 9 P5 + Check 32 P7: a card action keeps the owner's place; a send keeps Undo in view. */

const NAMES = ["Avery", "Blake", "Casey", "Drew", "Emery"];

/** Five plain draft cards, newest first in the order of NAMES (no Gmail draft behind them). */
async function seedDrafts(mailboxId: string) {
  const out: { threadId: string; draftId: string; name: string }[] = [];
  for (const [n, name] of NAMES.entries()) {
    const at = new Date(Date.now() - (n + 1) * 60_000);
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId,
        gmailThreadId: `place-${n}-${mailboxId}`,
        inInbox: true,
        category: "customer_question",
        summary: `Question from ${name}.`,
        lastMessageAt: at,
      })
      .returning();
    const [m] = await testDb
      .insert(schema.messages)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m-place-${n}-${mailboxId}`,
        direction: "in",
        fromName: name,
        fromAddress: `${name.toLowerCase()}@x.com`,
        sentAt: at,
      })
      .returning();
    const [d] = await testDb
      .insert(schema.drafts)
      .values({
        threadId: t!.id,
        mailboxId,
        replyToMessageId: m!.id,
        gmailDraftId: null,
        toAddress: `${name.toLowerCase()}@x.com`,
        subject: "Re: Question",
        body: `Hi ${name},\n\nYes, we can do that.\n\nThanks, Sam`,
        originalBody: "same",
        reason: "A question.",
        confidence: 90,
        createdAt: at,
      })
      .returning();
    out.push({ threadId: t!.id, draftId: d!.id, name });
  }
  return out;
}

test("discarding a card further down lands on the next card, with the notice on it (Check 9 P5)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const cards = await seedDrafts(owner.mailboxId!);
  await signInAs(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/queue");
  const ids = await page
    .locator("article[id^=t-]")
    .evaluateAll((els) => els.map((e) => e.id.slice(2)));
  expect(ids).toHaveLength(5);
  const third = page.locator(`article#t-${ids[2]}`);
  const fourth = page.locator(`article#t-${ids[3]}`);
  await third.scrollIntoViewIfNeeded();
  await third.getByRole("button", { name: "Discard", exact: true }).click();
  await third.getByRole("button", { name: "Discard draft" }).click();

  await expect(page).toHaveURL(new RegExp(`done=discarded&t=${ids[3]}`));
  await expect(page.locator(`article#t-${ids[2]}`)).toHaveCount(0);
  await expect(fourth.getByRole("status").filter({ hasText: "Draft discarded." })).toBeVisible();
  await expect(fourth).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Only on that card, not also at the top.
  await expect(page.getByText("Draft discarded.")).toHaveCount(1);
  const [gone] = await testDb
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.id, cards.find((c) => c.threadId === ids[2])!.draftId));
  expect(gone!.status).toBe("discarded");
});

test("after a send the result has the h1, takes focus, and Undo is in view and the next Tab (Check 32 P7)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  const cards = await seedDrafts(owner.mailboxId!);
  // The first card was tapped: in its undo window, hidden from the queue.
  await testDb
    .update(schema.drafts)
    .set({ sendAfter: new Date(Date.now() + 120_000) })
    .where(eq(schema.drafts.id, cards[2]!.draftId));
  await signInAs(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/queue?sent=${cards[2]!.draftId}&t=${cards[3]!.threadId}`);

  const strip = page.getByTestId("sent-strip");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /reply on its way,\s*squared away\./,
  );
  await expect(strip).toBeInViewport();
  const undo = strip.getByRole("button", { name: "Undo" });
  await expect(undo).toBeInViewport();
  await expect(strip).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(undo).toBeFocused();
  // The page sits on the next card, not the top.
  await expect(page.locator(`article#t-${cards[3]!.threadId}`)).toBeInViewport();
  await expect(page.getByText(`You have 20 seconds to undo.`)).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
