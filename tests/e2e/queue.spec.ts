import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

test("queue: needs-you first, then drafts; sending is off until setup, and it says so", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);

  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByText("Customer says the leak came back.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a reply" })).toBeVisible();

  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card).toContainText("Asked for the address and panel age.");
  await expect(card).toContainText("Panel upgrade quote."); // what they want, at a glance
  await expect(card).toContainText("Check you can do Tuesday morning.");
  // The Send button is replaced by an explanation, not hidden.
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card.getByRole("note")).toContainText("Sending isn't on yet");

  await card.getByRole("button", { name: "Show full draft" }).click();
  await expect(card).toContainText("how old is the current panel?");
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(card.getByLabel("Your reply")).toHaveValue(/What's the address/);
  await expect(card.getByRole("button", { name: "Save changes" })).toBeVisible();
  // Plan #4: a change can be said or typed; the button appears once there's something to use.
  await expect(card.getByLabel("Tell it what to change")).toBeVisible();
  await expect(card.getByRole("button", { name: "Change the draft" })).toHaveCount(0);
  await card.getByLabel("Tell it what to change").fill("make it Tuesday");
  await expect(card.getByRole("button", { name: "Change the draft" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  // Plan #3: one-tap tweaks on the card.
  const tweaks = card.getByRole("form", { name: "Quick changes" });
  for (const name of ["Shorter", "Warmer", "More formal", "Ask for photos", "Add my availability"])
    await expect(tweaks.getByRole("button", { name })).toBeVisible();

  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card.getByRole("button", { name: "Discard draft" })).toBeVisible();
  await card.getByRole("button", { name: "Keep it" }).click();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("hitting the send endpoint directly before setup gets a 403", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");

  const sameOrigin = await page.request.post(`/api/drafts/${draft.id}/send`, {
    headers: { origin: baseURL! },
    data: {},
  });
  expect(sameOrigin.status()).toBe(403);
  const crossSite = await page.request.post(`/api/drafts/${draft.id}/send`, {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(crossSite.status()).toBe(403);

  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.status).toBe("pending");
});

test("after sending: the squared-away moment", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb.update(schema.drafts).set({ status: "sent" }).where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto(`/queue?sent=${draft.id}`);
  await expect(page.getByText("reply sent,")).toBeVisible();
  await expect(page.getByText("squared away.")).toBeVisible();
  // A quote: we say when we'll nudge if it goes quiet.
  await expect(page.getByText(/I'll nudge Priya on \w+day if there's no reply\./)).toBeVisible();
});

test("empty queue says so plainly", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByText("Nothing waiting on you.")).toBeVisible();
});

test("undo send: the window shows a countdown, and Undo puts the reply back", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ sendAfter: new Date(Date.now() + 120_000) })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto(`/queue?sent=${draft.id}`);
  await expect(page.getByText("reply on its way,")).toBeVisible();
  await expect(page.getByText(/Sending in \d+ seconds/)).toBeVisible();
  // While it's going, it's not in the queue to tap again.
  await expect(page.getByRole("article", { name: "Draft reply to Priya" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Stopped. Nothing was sent")).toBeVisible();
  await expect(page.getByRole("article", { name: "Draft reply to Priya" })).toBeVisible();
});

test("remind me later: the conversation leaves the queue until then", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await card.getByRole("button", { name: "Remind me later" }).click();
  await card.getByRole("button", { name: "After this job (3 hours)" }).click();
  await expect(page.getByText("Snoozed.")).toBeVisible();
  await expect(page.getByRole("article", { name: "Draft reply to Priya" })).toHaveCount(0);
});

test("review all ready: lists who and how it starts, then asks once before sending", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  // The seeded complaint needs the owner, so it's never in the batch.
  const { draft } = await seedQueue(owner.mailboxId!);
  // Make the seeded quote draft Ready, and add a second Ready one.
  await testDb
    .update(schema.drafts)
    .set({ flags: [], confidence: 92 })
    .where(eq(schema.drafts.id, draft.id));
  const [t2] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `s-${owner.mailboxId}`,
      inInbox: true,
      category: "scheduling",
      lastMessageAt: new Date(),
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t2!.id,
    mailboxId: owner.mailboxId!,
    gmailMessageId: `m-s-${owner.mailboxId}`,
    direction: "in",
    fromName: "Omar",
    fromAddress: "omar@x.com",
    sentAt: new Date(),
  });
  await testDb.insert(schema.drafts).values({
    threadId: t2!.id,
    mailboxId: owner.mailboxId!,
    gmailDraftId: "fake-draft-2",
    toAddress: "omar@x.com",
    subject: "Re: Time",
    body: "Hi Omar,\nTuesday works — see you then.\nSam",
    originalBody: "same",
    reason: "Confirms the time.",
    confidence: 95,
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  await page.getByRole("link", { name: "Review all 2 ready" }).click();
  await expect(page).toHaveURL(/\/queue\/review$/);
  const list = page.getByRole("list", { name: "Replies to send" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("To Omar");
  await expect(list).toContainText("Tuesday works — see you then.");
  await expect(list).toContainText("What's the address, and how old is the current panel?");

  // Untick Scheduling → only the quote is left.
  await page.getByRole("link", { name: "Scheduling" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("link", { name: "Scheduling" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await page.getByRole("button", { name: "Send 2 replies" }).click();
  await expect(page.getByRole("button", { name: "Yes, send 2 replies" })).toBeVisible();
  await page.getByRole("button", { name: "Not yet" }).click();
  await expect(page.getByRole("button", { name: "Send 2 replies" })).toBeVisible();
});
