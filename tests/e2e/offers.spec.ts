import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { lockReviewAddress } from "../../src/server/review-lock";
import { seedOwner, signInAs, testDb } from "./support";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const REVIEW_URL = "https://g.page/r/elm-electric/review";
const CLOSING = "Want to ask if they went another way?";

type Msg = { direction: "in" | "out"; daysAgo: number; body: string };

/** A thread from `from` with these messages; the owner's go to `from`. */
async function thread(
  mailboxId: string,
  from: { name: string; address: string },
  over: Partial<typeof schema.threads.$inferInsert>,
  msgs: Msg[],
) {
  const gid = `offer-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      classifiedAt: new Date(),
      lastMessageAt: ago(Math.min(...msgs.map((m) => m.daysAgo))),
      ...over,
    })
    .returning();
  await testDb.insert(schema.messages).values(
    msgs.map((m, i) => ({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${gid}-${i}`,
      direction: m.direction,
      fromAddress: m.direction === "in" ? from.address : "owner@example.com",
      fromName: m.direction === "in" ? from.name : null,
      toAddresses: m.direction === "out" ? [from.address] : ["owner@example.com"],
      subject: "Panel upgrade",
      bodyText: m.body,
      sentAt: ago(m.daysAgo),
    })),
  );
  return t!.id;
}

const finishedJob: Msg[] = [
  { direction: "in", daysAgo: 6, body: "Can you swap the panel?" },
  { direction: "out", daysAgo: 5, body: "Yes, Thursday. Davi" },
  { direction: "in", daysAgo: 0.05, body: "All done, looks great!" },
];

async function seed() {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await testDb
    .insert(schema.businessProfiles)
    .values({ workspaceId: owner.workspaceId, reviewUrl: REVIEW_URL });
  const box = owner.mailboxId!;
  const dana = await thread(
    box,
    { name: "Dana Ruiz", address: "dana@customer.com" },
    {
      category: "customer_question",
      summary: "Dana says the panel job looks great.",
      extracted: { job_done: true },
    },
    finishedJob,
  );
  // A complaint with "job done" in it is never offered (server-side rule).
  await thread(
    box,
    { name: "Sam Lee", address: "sam@customer.com" },
    {
      category: "complaint",
      needsOwner: true,
      needsOwnerReason: "Customer is unhappy.",
      summary: "Sam says the job is done but the breaker trips.",
      extracted: { job_done: true },
      complainedAt: ago(2),
    },
    finishedJob,
  );
  // A quote that went quiet after both nudges: eligible for the closing question if the
  // flag were on — it isn't in e2e, so the button must never show.
  const quiet = await thread(
    box,
    { name: "Lee Park", address: "lee@customer.com" },
    { category: "quote_request", summary: "Lee wants a quote for a panel.", followupCount: 2 },
    [
      { direction: "in", daysAgo: 25, body: "How much for a panel?" },
      { direction: "out", daysAgo: 22, body: "$3,100 with the permit. Davi" },
      { direction: "out", daysAgo: 18, body: "Checking in. Davi" },
      { direction: "out", daysAgo: 10, body: "Any thoughts? Davi" },
    ],
  );
  for (const d of [18, 10]) {
    await testDb.insert(schema.drafts).values({
      threadId: quiet,
      mailboxId: box,
      kind: "followup",
      status: "sent",
      toAddress: "lee@customer.com",
      subject: "Re: Panel upgrade",
      body: "Checking in.",
      reason: "Follow-up nudge.",
      createdAt: ago(d),
      decidedAt: ago(d),
    });
  }
  return { owner, dana };
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

test("review offer: on a finished job only, never a complaint; a tap is re-checked on the server", async ({
  page,
  context,
}) => {
  const { owner, dana } = await seed();
  await signInAs(context, owner);

  await page.goto("/inbox");
  // One offer in the whole inbox (counted in the DOM, open rows or not): Dana's.
  await expect(page.locator("form button", { hasText: "Ask for a review" })).toHaveCount(1);
  await expect(page.getByText(CLOSING)).toHaveCount(0);

  await page.getByText("Dana says the panel job looks great.").click();
  const ask = page.getByRole("button", { name: "Ask for a review" });
  await expect(ask).toBeVisible();
  const box = await ask.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);

  // Meanwhile a review request went to Dana (another tap, another phone): the server
  // refuses this one before any model call, and says why.
  await testDb.insert(schema.drafts).values({
    threadId: dana,
    mailboxId: owner.mailboxId!,
    kind: "reply",
    purpose: "review_request",
    status: "sent",
    toAddress: "dana@customer.com",
    subject: "Re: Panel upgrade",
    body: `A review? ${REVIEW_URL}`,
    reason: "Review request.",
    decidedAt: new Date(),
  });
  await ask.click();
  await expect(page).toHaveURL(/\/queue\?error=review_recent/);
  await expect(page.getByText("You asked them for a review in the last 12 months.")).toBeVisible();

  // And it's no longer offered.
  await page.goto("/inbox");
  await expect(page.locator("form button", { hasText: "Ask for a review" })).toHaveCount(0);
});

test("closing question: never shown while FEATURE_CLOSING_QUESTION is unset", async ({
  page,
  context,
}) => {
  const { owner } = await seed();
  await signInAs(context, owner);
  for (const path of ["/inbox", "/quotes", "/quotes?stage=quiet", "/money"]) {
    await page.goto(path);
    await expect(page.getByText(CLOSING)).toHaveCount(0);
  }
});

test("a review request waits in the Queue, labelled, with the owner's link", async ({
  page,
  context,
}) => {
  const { owner, dana } = await seed();
  await testDb.insert(schema.drafts).values({
    threadId: dana,
    mailboxId: owner.mailboxId!,
    kind: "reply",
    purpose: "review_request",
    gmailDraftId: "fake-review-draft",
    toAddress: "dana@customer.com",
    subject: "Re: Panel upgrade",
    body: `Hi Dana,\n\nThanks again. If you have a minute, a short review would mean a lot:\n${REVIEW_URL}\n\nDavi`,
    originalBody: "same",
    reason: "You asked for a review request.",
    confidence: 85,
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Dana Ruiz · draft reply" });
  await expect(card).toContainText("Review request");
  await card.getByRole("button", { name: "Show full draft" }).click();
  await expect(card).toContainText(REVIEW_URL);
  await noOverflow(page);

  // One is already waiting for Dana, so the Inbox doesn't offer another.
  await page.goto("/inbox");
  await expect(page.locator("form button", { hasText: "Ask for a review" })).toHaveCount(0);
});

test("money: a paid invoice offers Say thanks (it carries the review ask when allowed)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await testDb
    .insert(schema.businessProfiles)
    .values({ workspaceId: owner.workspaceId, reviewUrl: REVIEW_URL });
  await thread(
    owner.mailboxId!,
    { name: "Priya Shah", address: "priya@customer.com" },
    {
      category: "invoice_payment",
      summary: "Priya asks about the invoice.",
      extracted: {
        invoice: { invoice_number: "INV-7", amount: 900, due_date: null, status: "unpaid" },
        invoice_thread: true,
      },
      invoicePaidAt: ago(1),
      invoicePaidSource: "owner",
    },
    [
      { direction: "in", daysAgo: 6, body: "Got the invoice." },
      { direction: "out", daysAgo: 5, body: "Thanks Priya. Davi" },
    ],
  );
  await signInAs(context, owner);

  await page.goto("/money");
  const paid = page.getByRole("region", { name: "Paid in the last 30 days" });
  await expect(paid).toContainText("Priya Shah");
  // 2026-10-16: one button on a paid row; the separate "Ask for a review" isn't shown there.
  await expect(paid.getByRole("button", { name: "Say thanks" })).toBeVisible();
  await expect(paid.getByRole("button", { name: "Ask for a review" })).toHaveCount(0);
  await expect(page.getByText(CLOSING)).toHaveCount(0);
  await noOverflow(page);
});

// The success path of a tap ("Ask for a review" → /queue?done=drafted) needs a model, which
// e2e doesn't have; tests/unit/offers.test.ts covers it. What PGlite can't prove is that the
// per-address lock (A16) runs on real Postgres through postgres.js and really serializes.
test("review lock: real Postgres runs it, and a second tap for the same address waits", async () => {
  const ws = randomUUID();
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const firstHasIt = new Promise<void>((r) => (locked = r));

  const first = testDb.transaction(async (tx) => {
    await lockReviewAddress(tx, ws, "Dana@Customer.com");
    locked();
    await held;
    events.push("first done");
  });
  await firstHasIt;
  const second = testDb.transaction(async (tx) => {
    // Same address, different case: the same lock.
    await lockReviewAddress(tx, ws, "dana@customer.com");
    events.push("second locked");
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(events).toEqual([]);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(["first done", "second locked"]);
});
