import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

async function seedQueue(mailboxId: string) {
  const mk = async (g: string, over: Partial<typeof schema.threads.$inferInsert>, from: string) => {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId,
        gmailThreadId: `${g}-${mailboxId}`,
        inInbox: true,
        lastMessageAt: new Date(),
        ...over,
      })
      .returning();
    const [m] = await testDb
      .insert(schema.messages)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m-${g}-${mailboxId}`,
        direction: "in",
        fromName: from,
        fromAddress: `${from.toLowerCase()}@x.com`,
        sentAt: new Date(),
      })
      .returning();
    return { t: t!, m: m! };
  };
  const complaint = await mk(
    "c",
    {
      category: "complaint",
      needsOwner: true,
      needsOwnerReason: "Customer says the leak came back.",
      summary: "Leak is back.",
    },
    "Dana",
  );
  const quote = await mk(
    "q",
    { category: "quote_request", summary: "Panel upgrade quote." },
    "Priya",
  );
  const [draft] = await testDb
    .insert(schema.drafts)
    .values({
      threadId: quote.t.id,
      mailboxId,
      replyToMessageId: quote.m.id,
      gmailDraftId: "fake-draft",
      toAddress: "priya@x.com",
      subject: "Re: Panel",
      body: "Hey Priya,\n\nWhat's the address, and how old is the current panel?\n\nThanks, Davi",
      originalBody: "same",
      reason: "Quote request, panel upgrade. Asked for the address and panel age.",
      flags: ["Check you can do Tuesday morning."],
      confidence: 85,
    })
    .returning();
  return { complaint, quote, draft: draft! };
}

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
  await expect(card).toContainText("Check you can do Tuesday morning.");
  // The Send button is replaced by an explanation, not hidden.
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card.getByRole("note")).toContainText("Sending isn't on yet");

  await card.getByRole("button", { name: "Show full draft" }).click();
  await expect(card).toContainText("how old is the current panel?");
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(card.getByLabel("Your reply")).toHaveValue(/What's the address/);
  await expect(card.getByRole("button", { name: "Save changes" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();

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
  await expect(page.getByText("I'll let you know when Priya writes back.")).toBeVisible();
});

test("empty queue says so plainly", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByText("Nothing waiting on you.")).toBeVisible();
});
