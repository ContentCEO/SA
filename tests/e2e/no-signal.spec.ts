import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

/**
 * Check 8 P1: with no signal, a tap in the signed-in app is stopped before it leaves and says
 * nothing was sent or changed — never the crash page — and the tab bar stays. Check 9 P4: the
 * Edit box keeps the owner's text through a refusal, with gaps shown as words.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== "mobile", "phone only (the tab bar is the point)");
});

const BLOCKED = "No signal. Nothing was sent or changed. Try again when you have a bar.";
const tabBar = (page: Page) => page.locator('nav[aria-label="Main"].fixed');

async function paidOwner() {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  return owner;
}

/** One unpaid invoice on Money owed (for Mark paid). */
async function invoice(mailboxId: string) {
  const gid = `inv-${randomUUID().slice(0, 8)}`;
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId,
      gmailThreadId: gid,
      inInbox: true,
      category: "invoice_payment",
      summary: "Dana asks about the invoice.",
      lastMessageAt: new Date(Date.now() - 3 * 86_400_000),
      extracted: {
        invoice: { invoice_number: "INV-7", amount: 900, due_date: null, status: "unpaid" },
        invoice_thread: true,
      },
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${gid}-in`,
    direction: "in",
    fromAddress: "dana@customer.com",
    fromName: "Dana Ruiz",
    bodyText: "Got the invoice, thanks.",
    sentAt: new Date(Date.now() - 5 * 86_400_000),
  });
}

/** Offline, tap, see the strip and no crash page; nothing posted. Back online: the strip goes. */
async function tapOffline(page: Page, tap: () => Promise<void>) {
  const posts: string[] = [];
  const onRequest = (r: { method(): string; url(): string }) => {
    if (r.method() === "POST") posts.push(r.url());
  };
  page.on("request", onRequest);
  await page.context().setOffline(true);
  await expect(page.getByText("No signal right now.")).toBeVisible();
  await tap();
  await expect(page.getByRole("alert").filter({ hasText: BLOCKED })).toBeVisible();
  await expect(page.getByText("something broke")).toHaveCount(0);
  await expect(tabBar(page)).toBeVisible();
  expect(posts).toEqual([]);
  page.off("request", onRequest);
  await page.context().setOffline(false);
  await expect(page.getByText(BLOCKED)).toHaveCount(0);
}

test("no signal: Send reply, Mark paid, Sunlight and Save business profile say nothing was sent", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  const { draft } = await seedQueue(owner.mailboxId!);
  await invoice(owner.mailboxId!);
  await signInAs(context, owner);

  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await tapOffline(page, () => card.getByRole("button", { name: "Send reply" }).click());
  await tapOffline(page, () => page.getByRole("button", { name: "Sunlight" }).click());
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.sendAfter).toBeNull();

  await page.goto("/money");
  await page.waitForLoadState("networkidle");
  await tapOffline(page, () =>
    page
      .getByRole("article", { name: "Dana Ruiz" })
      .getByRole("button", { name: "Mark paid" })
      .click(),
  );

  await page.goto("/settings/profile");
  await page.waitForLoadState("networkidle");
  await tapOffline(page, () => page.getByRole("button", { name: "Save business profile" }).click());
});

test("no signal with offline okays on: Send reply is kept on the phone, not blocked", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await paidOwner();
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await context.addCookies([{ name: "sa_offline", value: "on", url: baseURL! }]);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await context.setOffline(true);
  await card.getByRole("button", { name: "Send reply" }).click();
  await expect(card.getByText("Will send when you're back online.")).toBeVisible();
  await expect(page.getByText(BLOCKED)).toHaveCount(0);
  await context.setOffline(false);
});

test("text typed in Edit survives no signal and a reload; the business profile's too", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await card.getByRole("button", { name: "Edit" }).click();
  const box = card.getByLabel("Your reply");
  await box.fill("Hey Priya, P.S. we can start Monday.");
  await context.setOffline(true);
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(BLOCKED)).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole("article", { name: "Draft reply to Priya" }).getByLabel("Your reply"),
  ).toHaveValue("Hey Priya, P.S. we can start Monday.");

  await page.goto("/settings/profile");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("What work do you take on?").fill("Panel upgrades. No new builds.");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Save business profile" }).click();
  await expect(page.getByText(BLOCKED)).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("What work do you take on?")).toHaveValue(
    "Panel upgrades. No new builds.",
  );
});

test("a request that fails on the way: the app's own error page, tab bar kept, card advice", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  // The phone still says it's online, but the request dies on the way (a weak signal).
  await page.route("**/queue**", (route) =>
    route.request().method() === "POST" ? route.abort("internetdisconnected") : route.fallback(),
  );
  await page
    .getByRole("article", { name: "Draft reply to Priya" })
    .getByRole("button", { name: "Send reply" })
    .click();
  await expect(page.getByText("if the card is still there, it wasn't sent")).toBeVisible();
  await expect(page.getByText("Something went wrong on our side.")).toHaveCount(0);
  await expect(tabBar(page)).toBeVisible();
});

test("Edit box: gaps read as words, and a refused Send reply keeps the editor and the text", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  const { draft } = await seedQueue(owner.mailboxId!);
  const gapBody = "Hey Priya,\n\nI can come by at {{time}}.\n\nThanks, Davi";
  await testDb
    .update(schema.drafts)
    .set({ body: gapBody, flags: [] })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);
  await page.goto("/queue");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await card.getByRole("button", { name: "Edit" }).click();
  const box = card.getByLabel("Your reply");
  await expect(box).toHaveValue("Hey Priya,\n\nI can come by at [time].\n\nThanks, Davi");
  await expect(card.getByText("Replace each [ ] before sending.")).toBeVisible();
  await expect(card.getByText("Fill in [time] first")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);

  await box.fill("Hey Priya,\n\nI can come by at 9am.\n\nThanks, Davi\nP.S. Bring the old panel.");
  const send = card.getByRole("button", { name: "Send reply" });
  await expect(send).toBeVisible();
  const sendBox = await send.boundingBox();
  expect(sendBox!.height).toBeGreaterThanOrEqual(44);

  // Meanwhile the draft changes (another device): the tap is refused inside the card.
  await testDb
    .update(schema.drafts)
    .set({ body: "Hey Priya, Tuesday works.\n\nThanks, Davi" })
    .where(eq(schema.drafts.id, draft.id));
  await send.click();
  await expect(card.getByRole("alert")).toContainText("nothing was sent");
  await expect(card.getByLabel("Your reply")).toHaveValue(
    "Hey Priya, Tuesday works.\n\nThanks, Davi",
  );
  await expect(card.getByLabel("Your text")).toHaveValue(
    "Hey Priya,\n\nI can come by at 9am.\n\nThanks, Davi\nP.S. Bring the old panel.",
  );
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.sendAfter).toBeNull();
  expect(after!.status).toBe("pending");
});
