import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
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
  await page.locator("main li").filter({ hasText: "Priya" }).locator("summary").first().click();
  await expect(page.getByText("Work")).toBeVisible();
  await page.getByRole("button", { name: "This one needs me" }).click();
  // Wait for the save to land before moving on.
  await expect(page.getByRole("button", { name: "This one needs me" })).toHaveCount(0);

  await page.goto("/inbox?c=needs_me");
  await expect(page.locator("main li")).toHaveCount(2);
  await expect(page.getByText("Priya", { exact: true }).first()).toBeVisible();
});

test("a failed inspection shows the permit card with what to fix", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `permit-${owner.mailboxId}`,
      inInbox: true,
      category: "customer_question",
      summary: "Rough electrical inspection failed at 12 Elm St.",
      lastMessageAt: new Date(),
      extracted: {
        municipal: true,
        permit: {
          issuing_body: "Town of Westford Building Dept.",
          permit_number: "E-2026-118",
          inspection_at: null,
          result: "failed",
          corrections: ["Missing GFCI in garage", "Label the panel"],
        },
      },
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId: owner.mailboxId!,
    gmailMessageId: `permit-m-${owner.mailboxId}`,
    direction: "in",
    fromAddress: "inspections@westfordma.gov",
    fromName: "Building Dept",
    sentAt: new Date(),
  });
  await signInAs(context, owner);
  await page.goto("/inbox");
  await page.getByText("Rough electrical inspection failed").click();
  const card = page.getByRole("region", { name: "Permit or inspection" });
  await expect(card).toContainText("Failed");
  await expect(card).toContainText("Permit E-2026-118");
  await expect(card).toContainText("2 things to fix:");
  await expect(card).toContainText("Missing GFCI in garage");
});

test("inbox: a word per row, junk folded into one line, and a search that stays on the phone", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  const now = Date.now();
  // Marco's thread: the owner has answered it.
  const [marco] = await testDb
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.gmailThreadId, `a-${owner.mailboxId}`));
  await testDb.insert(schema.messages).values({
    threadId: marco!.id,
    mailboxId: owner.mailboxId!,
    gmailMessageId: `m-a-out-${owner.mailboxId}`,
    direction: "out",
    fromAddress: owner.email,
    sentAt: new Date(now + 1000),
  });
  for (const g of ["j1", "j2"]) {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId: owner.mailboxId!,
        gmailThreadId: `${g}-${owner.mailboxId}`,
        inInbox: true,
        category: "noise",
        summary: `Newsletter ${g}.`,
        lastMessageAt: new Date(now - 60_000),
        subject: `Sale ${g}`,
      })
      .returning();
    await testDb.insert(schema.messages).values({
      threadId: t!.id,
      mailboxId: owner.mailboxId!,
      gmailMessageId: `m-${g}-${owner.mailboxId}`,
      direction: "in",
      fromName: "Big Box Store",
      fromAddress: `deals-${g}@store.example`,
      sentAt: new Date(now - 60_000),
    });
  }
  await signInAs(context, owner);
  await page.goto("/inbox");

  const row = (name: string) => page.locator("main li").filter({ hasText: name });
  await expect(row("Marco")).toContainText("Replied");
  await expect(row("Priya")).toContainText("Waiting on you");
  // Junk: one line at the end, which opens.
  const junk = page.getByText("2 junk emails");
  await expect(junk).toBeVisible();
  await expect(row("Newsletter j1.")).toBeHidden();
  await junk.click();
  await expect(row("Newsletter j1.")).toBeVisible();
  await expect(row("Newsletter j1.")).not.toContainText("Waiting on you");

  // Search filters on the phone; nothing typed goes into the URL.
  await page.waitForLoadState("networkidle");
  const search = page.getByLabel("Search your inbox");
  // Check 10 P2: the note says what a search looks through (3 emails + 2 junk).
  await expect(page.getByText("Searching the 5 emails on this page.")).toBeVisible();
  await search.fill("water heater");
  await expect(page.locator("main li")).toHaveCount(1);
  await expect(row("Priya")).toBeVisible();
  await search.fill("store.example");
  await expect(page.locator("main li")).toHaveCount(2);
  await search.fill("nobody like this");
  await expect(page.getByText("No emails match that.")).toBeVisible();
  expect(page.url()).toMatch(/\/inbox$/);
  await search.fill("");
  await expect(page.getByText("2 junk emails")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("Check 10 P1: 'I called them' on an Inbox card turns it back to a normal card, no longer first", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  // Dana's complaint is the oldest, so only the flag puts it first.
  await testDb
    .update(schema.threads)
    .set({ lastMessageAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(schema.threads.gmailThreadId, `b-${owner.mailboxId}`));
  await signInAs(context, owner);
  await page.goto("/inbox");
  const items = page.locator("main li");
  await expect(items.first()).toContainText("Dana");
  await expect(items.first()).toContainText("Needs you");

  await page.locator("main li").filter({ hasText: "Dana" }).locator("summary").first().click();
  await items.first().getByRole("button", { name: "I called them" }).click();
  await page.getByRole("button", { name: "Yes, I called them" }).click();
  await expect(page).toHaveURL(/\/inbox\?done=called/);
  await expect(page.getByText("Marked as answered by phone.")).toBeVisible();
  await expect(items.first()).not.toContainText("Dana");
  const dana = items.filter({ hasText: "Dana" });
  await expect(dana).not.toContainText("Complaint · Needs you");
  await expect(dana).toContainText("Complaint · Replied");
  await expect(dana.locator("details").first()).not.toHaveClass(/sa-inverted/);
});

test("Check 10 P3: a burst pipe from today says Emergency and comes first", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  const at = new Date(Date.now() - 2 * 60 * 60_000);
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `pipe-${owner.mailboxId}`,
      inInbox: true,
      category: "customer_question",
      priority: "high",
      needsOwner: true,
      needsOwnerReason: "An emergency.",
      summary: "Burst pipe in the basement, water everywhere.",
      lastMessageAt: at,
      extracted: { urgency: "emergency" },
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId: owner.mailboxId!,
    gmailMessageId: `pipe-m-${owner.mailboxId}`,
    direction: "in",
    fromName: "Kevin",
    fromAddress: "kevin@example.com",
    sentAt: at,
  });
  await signInAs(context, owner);
  await page.goto("/inbox");
  const first = page.locator("main li").first();
  await expect(first).toContainText("Kevin");
  await expect(first).toContainText("Emergency · Question · Needs you");
  await expect(page.locator("main li").nth(1)).toContainText("Dana");
});

test("Check 10 P2: past the first 100, Show older emails pages on and Back to newest returns", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const now = Date.now();
  await testDb.insert(schema.threads).values(
    Array.from({ length: 103 }, (_, i) => ({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `old-${i}-${owner.mailboxId}`,
      inInbox: true,
      category: "scheduling",
      summary: `Visit number ${i + 1}.`,
      lastMessageAt: new Date(now - i * 60_000),
    })),
  );
  await signInAs(context, owner);
  await page.goto("/inbox");
  await expect(page.locator("main li")).toHaveCount(100);
  await expect(page.getByText("Searching the 100 emails on this page.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Search your inbox").fill("Visit number 103.");
  await expect(page.getByText("No emails match that.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Show older emails" })).toBeVisible();
  await page.getByLabel("Search your inbox").fill("");
  await page.getByRole("link", { name: "Show older emails" }).click();
  await expect(page).toHaveURL(/after_id=/);
  await expect(page.locator("main li")).toHaveCount(3);
  await expect(page.getByText("Visit number 103.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Show older emails" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to newest" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.locator("main li")).toHaveCount(100);
});

test("Check 10 P4 + P5: Draft ready goes to the draft; the reason shows on a closed card", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  const [priya] = await testDb
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.gmailThreadId, `c-${owner.mailboxId}`));
  await testDb.insert(schema.drafts).values({
    threadId: priya!.id,
    mailboxId: owner.mailboxId!,
    kind: "reply",
    gmailDraftId: `gd-${owner.mailboxId}`,
    toAddress: "priya@example.com",
    subject: "Re: Subject c",
    body: "Hi Priya, happy to quote the water heater.",
    originalBody: "Hi Priya, happy to quote the water heater.",
    reason: "Quote request",
    flags: [],
    confidence: 80,
    promptVersion: "draft.v7",
  });
  await signInAs(context, owner);
  await page.goto("/inbox");
  const row = (name: string) => page.locator("main li").filter({ hasText: name });

  // P5: closed cards. The reason is on the needs-you card's face, not on a normal one.
  await expect(
    row("Dana")
      .locator("summary")
      .first()
      .getByText("Complaint — you'll want to handle this yourself."),
  ).toBeVisible();
  await expect(row("Marco").locator("summary").first()).toHaveText(/Marco/);
  await expect(row("Marco").locator("summary").first()).not.toContainText("handle this yourself");

  // P4: Priya's card says a draft is ready and links to it.
  await expect(row("Priya")).toContainText("Waiting on you · Draft ready");
  await page.locator("main li").filter({ hasText: "Priya" }).locator("summary").first().click();
  await expect(row("Priya").getByRole("button", { name: "Draft a reply" })).toHaveCount(0);
  const see = row("Priya").getByRole("link", { name: "See the draft" });
  await expect(see).toHaveAttribute("href", `/queue?t=${priya!.id}#t-${priya!.id}`);
  // Marco has no draft: still offered.
  await page.locator("main li").filter({ hasText: "Marco" }).locator("summary").first().click();
  await expect(row("Marco").getByRole("button", { name: "Draft a reply" })).toBeVisible();
  await see.click();
  await expect(page).toHaveURL(/\/queue/);
  await expect(page.locator(`#t-${priya!.id}`)).toBeVisible();
});

test("Check 10 P6: an open Inbox card opens Gmail and the customer's page", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedThreads(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/inbox");
  const marco = page.locator("main li").filter({ hasText: "Marco" });
  await page.locator("main li").filter({ hasText: "Marco" }).locator("summary").first().click();
  const gmail = marco.getByRole("link", { name: "Open in Gmail" });
  await expect(gmail).toHaveAttribute(
    "href",
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(owner.email)}#all/a-${owner.mailboxId}`,
  );
  await expect(gmail).toHaveAttribute("target", "_blank");
  const name = marco.getByRole("link", { name: "Marco" });
  const href = await name.getAttribute("href");
  expect(href).toMatch(/^\/customers\/[0-9a-f-]{36}$/);
  expect(href).not.toContain("@");
  await name.click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(page.locator("main")).toContainText("Marco");
  await expect(page.locator("main")).toContainText("move rough-in to Thursday");
});
