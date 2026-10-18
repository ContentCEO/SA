import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Round 2, "First week" review (FW): what a new owner meets in their first days. */

test("a first-timer with no Gmail gets one big Connect Gmail, and step 1 of 3", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/queue");
  const start = page.getByRole("region", { name: "Start here" });
  await start.getByRole("link", { name: "Connect Gmail" }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
});

test("every draft card says how old the email is, and 'I called them' clears it", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { quote, complaint } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.messages)
    .set({ sentAt: new Date(Date.now() - 9 * DAY) })
    .where(eq(schema.messages.id, quote.m.id));
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(card).toContainText("Wrote 9 days ago");
  await card.getByRole("button", { name: "I called them" }).click();
  await expect(card).toContainText("Answered by phone?");
  await card.getByRole("button", { name: "Yes, I called them" }).click();
  await expect(page).toHaveURL(/done=called/);
  await expect(page.getByText("Marked as answered by phone.")).toBeVisible();
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toHaveCount(0);
  const [t] = await testDb.select().from(schema.threads).where(eq(schema.threads.id, quote.t.id));
  expect(t!.handledOfflineAt).not.toBeNull();

  // The needs-you card has it too.
  await expect(page.getByText("Customer says the leak came back.")).toBeVisible();
  void complaint;
});

test("the last day of the trial asks plainly, with a real Choose a plan button", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  const now = Date.now();
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(now - 3 * DAY + 5 * HOUR),
    evaluationEndsAt: new Date(now + 5 * HOUR),
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  const banner = page.getByRole("region", { name: "Your three days" });
  await expect(banner).toContainText("Your three days end in");
  await expect(banner).toContainText("written 1 draft");
  await banner.getByRole("link", { name: "Choose a plan" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  // The first charge, said plainly before Stripe (or the "not switched on" note without it).
  const plans = page.getByRole("listitem", { name: "Solo plan" });
  if (await plans.count()) await expect(plans).toContainText("Your first payment is");
});

test("an expired trial sees what's waiting, and the checklist offers a plan", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(Date.now() - 4 * DAY),
    evaluationEndsAt: new Date(Date.now() - DAY),
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  const banner = page.getByRole("status").filter({ hasText: "Your three days are up." });
  await expect(banner).toContainText(
    "Waiting for you: 1 reply drafted and 1 email that needs you.",
  );
  await expect(page.getByRole("link", { name: "Choose a plan to keep going" })).toBeVisible();
  await expect(page.getByRole("button", { name: "I called them" })).toHaveCount(0);
});

test("the terms box: tapping the words ticks it; the documents have their own links", async ({
  page,
}) => {
  await page.goto("/signin");
  const box = page.getByRole("checkbox", {
    name: "I agree to the Terms of Service and the Privacy Policy.",
  });
  await page.getByText("I agree to the Terms of Service and the Privacy Policy.").click();
  await expect(box).toBeChecked();
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.getByRole("link", { name: "Read the Terms of Service" })).toHaveAttribute(
    "href",
    "/terms",
  );
});

test("favicon.ico is there, and the privacy table scrolls from a keyboard", async ({
  page,
  request,
}) => {
  const icon = await request.get("/favicon.ico");
  expect(icon.status()).toBe(200);
  await page.goto("/privacy");
  const table = page.getByRole("region", { name: "Table, scrolls sideways" });
  await table.focus();
  await expect(table).toBeFocused();
});
