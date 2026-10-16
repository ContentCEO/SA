import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { localMonthName } from "../../src/server/snooze-rules";
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
  // Five tabs: Activity lives under More.
  const tabs = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
  await tabs.getByRole("link", { name: "More" }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(tabs.getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("navigation", { name: "More" })
    .getByRole("link", { name: /^Activity/ })
    .click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(tabs.getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");
  // Outside review K1: money leads; nothing won or paid yet says so plainly.
  const money = page.getByRole("region", {
    name: `Won and paid in ${localMonthName(new Date(), "America/New_York")}`,
  });
  await expect(money).toContainText("Nothing won or paid yet this month.");
  // The feed is grouped by day.
  await expect(page.getByRole("region", { name: "Today" })).toContainText(
    "You sent a reply to Priya",
  );
  await expect(page.getByText("You sent a reply to Priya")).toBeVisible();
  await expect(page.getByText("Drafted a reply to Priya · Quote request")).toBeVisible();
  // The month card (no profile → Eastern) and the week card each say it once.
  const month = page.getByRole("region", {
    name: `${localMonthName(new Date(), "America/New_York")} so far`,
  });
  await expect(month.getByText("Time saved: about 3 minutes.")).toBeVisible();
  await expect(
    month.getByText(/That's an estimate: 3 minutes for each drafted reply you sent/),
  ).toBeVisible();

  // Plan #32/#33: this week so far — the reply just sent from the app answers the quote
  // request at once (sync hasn't brought in its email yet), so the quote is out.
  const week = page.getByRole("region", { name: "This week so far" });
  await expect(week).toBeVisible();
  const figure = (label: string) =>
    week.locator("div").filter({ has: page.getByRole("term").filter({ hasText: label }) });
  await expect(figure("Replies sent").getByRole("definition")).toHaveText("1");
  await expect(figure("Follow-ups sent").getByRole("definition")).toHaveText("0");
  await expect(figure("Quotes out").getByRole("definition")).toHaveText("1");
  await expect(figure("Time saved (estimate)").getByRole("definition")).toHaveText(
    "about 3 minutes",
  );
  await expect(week).toContainText(
    "You answered quote requests in under a minute on average this week.",
  );
  await expect(week).not.toContainText("still waiting");
  await expect(week).toContainText("Nothing sent last week.");
  await expect(
    week.getByText(/That's an estimate: 3 minutes for each drafted reply you sent/),
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
        quoteAmountCents: d.outcome === "won" ? 420_000 : null,
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
  // Outside review K1: the money card leads, from the owner's own quote amount.
  const money = page.getByRole("region", { name: /^Won and paid in / });
  await expect(money).toContainText("Quotes won");
  await expect(money).toContainText("1 · $4,200");
  await expect(money).toContainText("Invoices paid after a follow-up");
  // The week card renders at phone width, with the estimate labelled as one.
  const week = page.getByRole("region", { name: "This week so far" });
  await expect(week.getByRole("heading", { name: "This week so far" })).toBeVisible();
  await expect(week.getByText("Time saved (estimate)")).toBeVisible();
  await expect(week.getByText(/That's an estimate/)).toBeVisible();
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
  await page.getByRole("link", { name: /^Morning email/ }).click();
  await expect(page).toHaveURL(/\/settings\/morning-email$/);
  const section = page.getByRole("main");
  await expect(section).toContainText("No customer names or email text go in it.");
  // Plan #35: the monthly summary rides on the same switch, and Settings says so.
  await expect(section).toContainText(
    "On the 1st of each month you also get a short summary of the month (counts only).",
  );
  const morning = section.getByRole("checkbox", { name: "Email me a summary each morning" });
  await expect(morning).toBeChecked();
  await expect(morning).toHaveAccessibleDescription("(and a short one on the 1st of each month)");
  await section.getByLabel("Send it at").selectOption("6");
  // A select doesn't save on its own (keyboard users choose first); its Save button does.
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  const [p] = await testDb
    .select()
    .from(schema.businessProfiles)
    .where(eq(schema.businessProfiles.workspaceId, owner.workspaceId));
  expect(p).toMatchObject({ digestEnabled: true, digestHour: 6, timeZone: "America/Chicago" });
});
