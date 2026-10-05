import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedAdmin, seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

test("autopilot is locked, with the reason, until Crew/Company and setup is done", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true });
  await setWorkspace(owner.workspaceId, { status: "setup_paid", plan: "solo" });
  await signInAs(context, owner);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Autopilot" });
  await expect(section).toContainText("Autopilot comes with the Crew and Company plans.");
  await expect(section.getByText("Turn on")).toHaveCount(0);

  await setWorkspace(owner.workspaceId, { plan: "crew" });
  await page.reload();
  await expect(section).toContainText("Autopilot opens up once your setup call is done.");
});

test("unlocked: each kind of email shows its progress; earned ones can be turned on", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, { status: "active", plan: "crew" });
  for (let i = 0; i < 10; i++) {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId: owner.mailboxId!,
        gmailThreadId: `earn-${i}-${owner.mailboxId}`,
        category: "scheduling",
      })
      .returning();
    await testDb.insert(schema.drafts).values({
      threadId: t!.id,
      mailboxId: owner.mailboxId!,
      gmailDraftId: `d-${i}`,
      sentGmailMessageId: `s-${i}`,
      toAddress: "x@y.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      status: "sent",
      reason: "r",
      promptVersion: "draft.v1",
    });
  }
  await signInAs(context, owner);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Autopilot" });
  await expect(section).toContainText(
    "Unlocks after 10 replies you sent without changing them (0 so far)",
  );

  const row = section.getByRole("listitem").filter({ hasText: "Scheduling" });
  await row.getByText("Turn on").click();
  await row.getByRole("button", { name: "Yes, send these on their own" }).click();
  await expect(page.getByText("Autopilot is on for that kind of email.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Autopilot" })
      .getByRole("listitem")
      .filter({ hasText: "Scheduling" }),
  ).toContainText("On");
  const [rule] = await testDb
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.workspaceId, owner.workspaceId));
  expect(rule?.mode).toBe("autopilot");
});

test("queue: an autopilot reply says when it sends, and Hold it stops it", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, { status: "active", plan: "crew" });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ autoSendAt: new Date(Date.now() + 8 * 60_000) })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("status")).toContainText(/Autopilot sends this at \d{1,2}:\d{2}/);
  await card.getByRole("button", { name: "Hold it" }).click();
  await expect(page.getByText("Held. It won't send until you tap Send reply.")).toBeVisible();
  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after).toMatchObject({ status: "pending", autoSendAt: null });
});

test("admin: set an owner's plan by hand", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, await seedAdmin());
  await page.goto("/admin");
  const card = page.getByRole("article", { name: owner.email });
  await card.getByLabel("Plan").selectOption("crew");
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Plan saved.")).toBeVisible();
  const [w] = await testDb
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w?.plan).toBe("crew");
});
