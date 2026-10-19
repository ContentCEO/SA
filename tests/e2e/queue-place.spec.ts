import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

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

test("an emergency with a draft is the first card on the page, under Right now (Check 9 P6)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  const cards = await seedDrafts(owner.mailboxId!);
  const pipe = cards.at(-1)!;
  await testDb
    .update(schema.threads)
    .set({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: "Emergency: water is coming through the basement ceiling.",
      lastMessageAt: new Date(Date.now() - 12 * 60_000),
    })
    .where(eq(schema.threads.id, pipe.threadId));
  await signInAs(context, owner);
  await page.goto("/queue");
  const first = page.locator("article[id^=t-]").first();
  await expect(first).toHaveAttribute("id", `t-${pipe.threadId}`);
  const rightNow = page.getByRole("region", { name: "Right now" });
  await expect(rightNow.locator(`article#t-${pipe.threadId}`)).toBeVisible();
  // Shown once, not again under Replies ready.
  await expect(page.locator(`article#t-${pipe.threadId}`)).toHaveCount(1);
  const box = await rightNow.boundingBox();
  const needs = await page.getByRole("region", { name: "Needs you" }).boundingBox();
  expect(box!.y).toBeLessThan(needs!.y);
});

test("the whole reply is on the card above Send reply; no toggle where nothing is hidden (Check 9 P7)", async ({
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
  const long = cards[0]!;
  await testDb
    .update(schema.drafts)
    .set({
      body: "Hey Avery,\n\nYes, we pull the gas permit and book the inspection.\nWhere is the range going?\nHow far is it from the meter?\nA photo of the spot helps.\n\nThanks, Sam",
      flags: [],
      confidence: 92,
    })
    .where(eq(schema.drafts.id, long.draftId));
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.locator(`article#t-${long.threadId}`);
  await expect(card.getByRole("button", { name: "Send reply" })).toBeVisible();
  const reply = card.locator("p.whitespace-pre-line");
  await expect(reply).toContainText("Thanks, Sam");
  // Nothing folded away: the text's full height is on screen.
  expect(await reply.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await expect(page.getByRole("button", { name: "Show full draft" })).toHaveCount(0);
});

test("a short draft on a card that folds has no Show full draft (Check 9 P7)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const cards = await seedDrafts(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ body: "Hi Avery,\nYes, we can do that.\nThanks, Sam" })
    .where(eq(schema.drafts.id, cards[0]!.draftId));
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.locator(`article#t-${cards[0]!.threadId}`);
  await expect(card).toContainText("Yes, we can do that.");
  await page.waitForLoadState("networkidle");
  await expect(card.getByRole("button", { name: "Show full draft" })).toHaveCount(0);
});

test("a draft of five or more lines has Show full draft in the server's HTML: nothing moves at hydration", async ({
  page,
  context,
}) => {
  // E2E hardening (2026-10-19): only measured in the browser, the toggle appeared as the card
  // hydrated and pushed Edit and Discard 52px down, so a tap already on its way (a slow phone,
  // or a test's click) landed on the note above them.
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!); // Priya's draft: five lines, on a card that folds
  await signInAs(context, owner);
  const html = await (await page.request.get("/queue")).text();
  expect(html).toContain("Show full draft");
});

test("'Fill in 1 gap to send' opens the gap's fill box; filling it brings Send reply (Check 9 P11)", async ({
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
  await testDb
    .update(schema.drafts)
    .set({ body: "Hi Avery,\n\nI can be there at {{time}} on Tuesday.\n\nThanks, Sam" })
    .where(eq(schema.drafts.id, cards[0]!.draftId));
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.locator(`article#t-${cards[0]!.threadId}`);
  const fill = card.getByRole("button", { name: "Fill in 1 gap to send" });
  expect((await fill.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await fill.click();
  const input = card.getByLabel("What should “time” say?");
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport();
  await input.fill("8am");
  await card.getByRole("button", { name: "Fill in", exact: true }).click();
  await expect(card).toContainText("I can be there at 8am on Tuesday.");
  await expect(card.getByRole("button", { name: "Send reply" })).toBeVisible();
});
