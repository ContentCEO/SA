import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

/** Wave 1 "Send path": what the queue says before and after a tap. */

async function paidOwner() {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  return owner;
}

test("an old draft that says 'tomorrow' asks once more: Send reply anyway or Edit (Check 43 P7)", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({
      body: "Hey Priya,\n\nTomorrow works, I'll confirm the time.\n\nThanks, Davi",
      flags: [],
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("note").filter({ hasText: "Check the timing." })).toContainText(
    /Written \w+day\. It says “tomorrow”, which meant \w+day\. Check the timing\./,
  );
  const anyway = card.getByRole("button", { name: "Send reply anyway" });
  const edit = card.getByRole("button", { name: "Edit" });
  await expect(anyway).toBeVisible();
  await expect(edit).toBeVisible();
  await expect(card.getByRole("button", { name: "Send reply", exact: true })).toHaveCount(0);
  for (const b of [anyway, edit])
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  // The tap carries the owner's yes; without it the server refuses before any Gmail call.
  await expect(
    card.locator('form:has(button:text("Send reply anyway")) input[name="confirmedTiming"]'),
  ).toHaveValue("1");
  const plain = await page.request.post(`/api/drafts/${draft.id}/send`, {
    headers: { origin: new URL(page.url()).origin },
    data: {},
  });
  expect(plain.status()).toBe(409);
  expect(await plain.json()).toMatchObject({ status: "timing_check", words: ["tomorrow"] });
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.sendAfter).toBeNull();
  expect(after!.status).toBe("pending");
});

test("a stopped send says why, and a late one waits on top with Stop it (Check 9 P10)", async ({
  page,
  context,
}) => {
  const owner = await paidOwner();
  const { draft } = await seedQueue(owner.mailboxId!);
  // The send job stopped it after the window: changed in Gmail, back in the queue.
  await testDb.insert(schema.activityLog).values({
    workspaceId: owner.workspaceId,
    actor: "squared_away",
    action: "send_stopped",
    threadId: draft.threadId,
    detail: { draftId: draft.id, why: "changed_in_gmail" },
  });
  await signInAs(context, owner);
  await page.goto(`/queue?sent=${draft.id}`);
  await expect(
    page.getByText("Didn't send. It was changed in Gmail, so it's back below to check."),
  ).toBeVisible();
  await expect(page.getByText("reply sent,")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Draft reply to Priya" })).toBeVisible();

  // Tapped again, and the job's event was lost: two minutes past the window, nobody holds it.
  await testDb
    .update(schema.drafts)
    .set({ sendAfter: new Date(Date.now() - 2 * 60_000) })
    .where(eq(schema.drafts.id, draft.id));
  await page.goto("/queue");
  await expect(page.getByText("Waiting to send: reply to Priya")).toBeVisible();
  await expect(page.getByText("Still sending. This is taking longer than usual.")).toBeVisible();
  await page.getByRole("button", { name: "Stop it" }).click();
  await expect(page.getByText("Stopped. Nothing was sent")).toBeVisible();
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.sendAfter).toBeNull();
  expect(after!.status).toBe("pending");
});
