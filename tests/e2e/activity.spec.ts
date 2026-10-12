import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, signInAs, testDb } from "./support";

test("activity: plain log, honest estimate, reachable from the menu", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft, quote } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ status: "sent", decidedAt: new Date() })
    .where(eq(schema.drafts.id, draft.id));
  await testDb.insert(schema.activityLog).values([
    {
      workspaceId: owner.workspaceId,
      actor: "squared_away",
      action: "draft_created",
      threadId: quote.t.id,
      detail: { draftId: draft.id },
    },
    {
      workspaceId: owner.workspaceId,
      actor: "owner",
      action: "reply_sent",
      threadId: quote.t.id,
      detail: { draftId: draft.id, editedByOwner: false, kind: "reply" },
    },
  ]);
  await signInAs(context, owner);

  await page.goto("/queue");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Activity" })
    .click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByText("You sent a reply to Priya")).toBeVisible();
  await expect(page.getByText("Drafted a reply to Priya · Quote request")).toBeVisible();
  await expect(page.getByText("Time saved: about 3 minutes.")).toBeVisible();
  await expect(
    page.getByText(/That's an estimate: 3 minutes for each drafted reply you sent/),
  ).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("activity at 375px: monthly close rate counts owner and auto outcomes, Money owed link works", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const now = new Date();
  const decided = [
    { name: "Ana", outcome: "won", source: "owner" },
    { name: "Ben", outcome: "lost", source: "owner" },
    { name: "Cy", outcome: "no_answer", source: "auto" },
  ] as const;
  for (const d of decided) {
    const gid = `close-${d.name}-${randomUUID().slice(0, 8)}`;
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId: owner.mailboxId!,
        gmailThreadId: gid,
        inInbox: true,
        category: "quote_request",
        summary: `${d.name} wants a quote.`,
        lastMessageAt: now,
        quoteOutcome: d.outcome,
        quoteOutcomeSource: d.source,
        quoteOutcomeAt: now,
      })
      .returning();
    await testDb.insert(schema.messages).values({
      threadId: t!.id,
      mailboxId: owner.mailboxId!,
      gmailMessageId: `${gid}-in`,
      direction: "in",
      fromName: d.name,
      fromAddress: `${d.name.toLowerCase()}@customer.com`,
      sentAt: now,
    });
  }
  await signInAs(context, owner);

  await page.goto("/activity");
  const close = page.getByRole("region", { name: "Quotes decided this month" });
  await expect(close).toContainText("You won 1 of 3 quotes decided this month (33%).");
  // Won / Lost / No answer: one each — the auto "no answer" counts as decided.
  await expect(close.getByRole("definition")).toHaveText(["1", "1", "1"]);
  for (const label of ["Won", "Lost", "No answer"]) {
    await expect(
      close.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }),
    ).toBeVisible();
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await page.getByRole("link", { name: "Money owed →" }).click();
  await expect(page).toHaveURL(/\/money$/);
  await expect(page.getByRole("region", { name: "Owed to you" })).toBeVisible();
});

test("settings: morning summary time and time zone are saved", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await context.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: "America/Chicago" };
    };
  });
  await signInAs(context, owner);

  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Morning summary" });
  await expect(section).toContainText("No customer names or email text go in it.");
  await section.getByLabel("Send it at").selectOption("6");
  await section.getByRole("button", { name: "Save morning summary" }).click();
  await expect(page.getByText("Morning summary saved.")).toBeVisible();

  const [p] = await testDb
    .select()
    .from(schema.businessProfiles)
    .where(eq(schema.businessProfiles.workspaceId, owner.workspaceId));
  expect(p).toMatchObject({ digestEnabled: true, digestHour: 6, timeZone: "America/Chicago" });
});
