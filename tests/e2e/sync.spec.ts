import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

test("while the first read is running, Settings says so plainly", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/settings/gmail");
  await expect(page.getByText(/Reading your last 30 days of email/)).toBeVisible();
});

test("after the backfill, Settings shows how much was read and when", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true, messageCount: 3 });
  await signInAs(context, owner);
  await page.goto("/settings/gmail");
  // Check 15 P10: the check time is said once, in the health list.
  await expect(page.getByText("3 emails from the last 30 days.", { exact: true })).toBeVisible();
  await expect(page.getByText(/checked just now/)).toHaveCount(0);
  const health = page.getByRole("definition").filter({ hasText: "Checked every 5 minutes." });
  await expect(health).toBeVisible();
  // Healthy: no Reconnect button in the Gmail section.
  await expect(
    page.getByRole("region", { name: "Your Gmail" }).getByRole("link", { name: "Reconnect Gmail" }),
  ).toHaveCount(0);
});

test("a stale inbox says so in one line on every signed-in screen (Check 25 P6)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  const line = page.getByText(
    /^Mail last checked .* New emails may not be here yet\. They're safe in Gmail\.$/,
  );
  // Fresh: no line.
  await page.goto("/queue");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(line).toHaveCount(0);
  // 42 minutes without a check: the line, on the Queue and elsewhere.
  await testDb
    .update(schema.mailboxes)
    .set({ lastSyncedAt: new Date(Date.now() - 42 * 60_000) })
    .where(eq(schema.mailboxes.id, owner.mailboxId!));
  for (const path of ["/queue", "/inbox", "/settings"]) {
    await page.goto(path);
    await expect(line).toBeVisible();
    await expect(line).toContainText("42 minutes ago");
  }
  await page.goto("/settings/gmail");
  await expect(
    page.getByText("Should be every 5 minutes. The last check was 42 minutes ago."),
  ).toBeVisible();
  // A read-only account isn't checked on purpose: no line (its banner explains).
  await testDb
    .update(schema.workspaces)
    .set({ status: "canceled" })
    .where(eq(schema.workspaces.id, owner.workspaceId));
  await page.goto("/queue");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(line).toHaveCount(0);
});

test("lost Google access shows a Reconnect Gmail banner on every screen", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, status: "reconnect_needed", backfilled: true });
  await signInAs(context, owner);

  for (const path of ["/settings", "/connect"]) {
    await page.goto(path);
    const banner = page.getByRole("alert").filter({ hasText: "lost access" });
    await expect(banner).toContainText(owner.email);
    await expect(banner.getByRole("link", { name: "Reconnect Gmail" })).toBeVisible();
  }
  // The Settings list flags it, and the Gmail screen says what happened.
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /^Your Gmail/ })).toContainText("Needs reconnecting");
  await page.goto("/settings/gmail");
  await expect(page.getByText("Needs reconnecting")).toBeVisible();
  const gmail = page.getByRole("region", { name: "Your Gmail" });
  await expect(gmail).toContainText(
    "Removed. Squared Away can't read this inbox until you reconnect.",
  );
  await expect(gmail.getByRole("link", { name: "Reconnect Gmail" })).toBeVisible();
});

test("Gmail push rejects requests without the shared token", async ({ request }) => {
  const res = await request.post("/api/gmail/push", { data: { message: { data: "" } } });
  expect(res.status()).toBe(403);
});
