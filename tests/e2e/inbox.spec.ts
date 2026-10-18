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
  await page.getByText("Priya", { exact: true }).click();
  await expect(page.getByText("Work")).toBeVisible();
  await page.getByRole("button", { name: "This one needs me" }).click();
  // Wait for the save to land before moving on.
  await expect(page.getByRole("button", { name: "This one needs me" })).toHaveCount(0);

  await page.goto("/inbox?c=needs_me");
  await expect(page.locator("main li")).toHaveCount(2);
  await expect(page.getByText("Priya", { exact: true })).toBeVisible();
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
      // Check 36 P4: a town email needs the owner, with a line from its permit facts.
      needsOwner: true,
      needsOwnerReason: "From the town: inspection failed, 2 things to fix.",
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

  // Check 37 P2: folded, the row says what's left to fix…
  await page.goto("/inbox");
  await expect(page.getByText("Permit E-2026-118 · 2 things to fix")).toBeVisible();
  // …and the Queue's Needs-you card shows the permit card.
  await page.goto("/queue");
  const queueCard = page.locator(`#t-${t!.id}`);
  await expect(queueCard).toContainText("From the town: inspection failed, 2 things to fix.");
  const permitOnQueue = queueCard.getByRole("region", { name: "Permit or inspection" });
  await expect(permitOnQueue).toContainText("Failed");
  await expect(permitOnQueue).toContainText("Missing GFCI in garage");
  await expect(permitOnQueue).toContainText("Label the panel");
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
