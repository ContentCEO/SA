import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedAdmin, seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

const DAY = 86_400_000;

test("during the three days: the clock is on every screen and sending is off", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  const now = Date.now();
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(now - DAY / 2),
    evaluationEndsAt: new Date(now + 2.5 * DAY),
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const clock = page.getByRole("region", { name: "Your three days" });
  await expect(clock).toContainText("Day 1 of 3");
  await expect(clock).toContainText("2 days");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("note")).toContainText("Sending is off during your three days");
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();

  await page.goto("/inbox");
  await expect(page.getByRole("region", { name: "Your three days" })).toBeVisible();
});

test("after the three days: read-only, and it says why", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  // The clock ran out but no job has recorded it yet — the screen must still know.
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(Date.now() - 4 * DAY),
    evaluationEndsAt: new Date(Date.now() - DAY),
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const banner = page.getByRole("status").filter({ hasText: "Your three days are up." });
  await expect(banner).toContainText("read-only");
  await expect(banner.getByRole("link", { name: "978-201-9763" })).toBeVisible();
  await expect(page.getByText("Customer says the leak came back.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a reply" })).toHaveCount(0);

  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card).toContainText("Asked for the address and panel age.");
  await expect(card.getByRole("note")).toContainText("Sending turns on after setup");
  await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
});

test("/admin is invisible to owners", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});

test("admin: sees health with no email content, and can turn sending on", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    businessName: "Leak Busters",
    evaluationStartedAt: new Date(),
    evaluationEndsAt: new Date(Date.now() + 3 * DAY),
  });
  const admin = await seedAdmin();
  await signInAs(context, admin);

  await page.goto("/settings");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);

  const card = page.getByRole("article", { name: owner.email });
  await expect(card).toContainText("Leak Busters");
  await expect(card).toContainText("Evaluating");
  await expect(card).toContainText("Drafts waiting");
  // No customer names, summaries or draft text on the admin page.
  for (const secret of ["Priya", "Dana", "leak came back", "panel age"]) {
    await expect(page.locator("main")).not.toContainText(secret);
  }

  // Only a real Stripe payment turns sending on: no admin button can do it for a customer.
  await expect(card).toContainText("Not yet");
  await expect(card.getByText("Mark setup paid")).toHaveCount(0);
  await expect(card.getByText("Use as my own test account")).toHaveCount(0);

  // Davi's own card (always pinned first) has the test-account switch.
  await testDb
    .update(schema.workspaces)
    .set({ setupPaidVia: null })
    .where(eq(schema.workspaces.ownerUserId, admin.userId));
  await page.reload();
  const mine = page.getByRole("article", { name: admin.email });
  await mine.getByText("Use as my own test account").click();
  await mine.getByRole("button", { name: "Yes, this is my account" }).click();
  await expect(page.getByText("Your account can send now")).toBeVisible();
  await expect(page.getByRole("article", { name: admin.email })).toContainText(
    "Your own test account",
  );

  const [w] = await testDb
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w!.status).toBe("evaluating");
  expect(w!.setupPaidVia).toBeNull();
});

test("admin: invite an owner", async ({ page, context }) => {
  const admin = await seedAdmin();
  await signInAs(context, admin);
  const email = `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

  await page.goto("/admin");
  await page.getByLabel("Their Gmail address").fill(email);
  await page.getByLabel("Trade").selectOption("electrical");
  await page.getByRole("button", { name: "Add to invite list" }).click();
  await page.waitForURL(/done=invited/);
  await expect(page.getByText("Invited. They can sign in now")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  const [row] = await testDb.select().from(schema.invites).where(eq(schema.invites.email, email));
  expect(row?.trade).toBe("electrical");
});
