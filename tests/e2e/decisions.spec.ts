import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/crypto";
import { seedOwner, setWorkspace, signInAs, testDb } from "./support";

/** Davi's decisions of 2026-10-16, through the real app at 375px. */

test("a lower plan: the paused Gmail address says why, and 'Use this one instead' swaps", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, { status: "active", plan: "solo", setupPaidVia: "stripe" });
  const [second] = await testDb
    .insert(schema.mailboxes)
    .values({
      workspaceId: owner.workspaceId,
      email: "office@example.com",
      encryptedRefreshToken: encryptSecret("fake-refresh-token"),
      scopes: "gmail",
      planPausedAt: new Date(),
    })
    .returning();
  await signInAs(context, owner);

  await page.goto("/settings/gmail");
  const paused = page.getByRole("listitem", { name: "office@example.com" });
  await expect(paused).toContainText("Paused: your plan covers 1 Gmail address.");
  await expect(paused).toContainText(`${owner.email} is paused in its place.`);
  await paused.getByRole("button", { name: "Use this one instead" }).click();
  await expect(
    page.getByText("Done. That Gmail is on now, and the other one is paused."),
  ).toBeVisible();

  const rows = await testDb
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.workspaceId, owner.workspaceId));
  expect(rows.find((m) => m.id === second!.id)!.planPausedAt).toBeNull();
  expect(rows.find((m) => m.id === owner.mailboxId)!.planPausedAt).not.toBeNull();
  // The one now paused says so; nothing spills at 375px.
  await expect(page.getByRole("listitem", { name: owner.email })).toContainText(
    "Paused: your plan covers 1 Gmail address.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
});

test("'Stop these emails': one click with the signed link; a forged one changes nothing", async ({
  page,
}) => {
  const owner = await seedOwner({ mailbox: true });
  const sig = createHmac("sha256", process.env.AUTH_SECRET!)
    .update(`trial-emails:stop:${owner.workspaceId}`)
    .digest("base64url");
  const stopped = async () =>
    (
      await testDb
        .select({ at: schema.workspaces.trialEmailsStoppedAt })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, owner.workspaceId))
    )[0]!.at;

  await page.goto(`/api/emails/stop?w=${owner.workspaceId}&s=forged`);
  await expect(page).toHaveURL(/\/emails\/stopped\?link=bad$/);
  await expect(page.getByText("Nothing was changed.")).toBeVisible();
  expect(await stopped()).toBeNull();

  await page.goto(`/api/emails/stop?w=${owner.workspaceId}&s=${sig}`);
  await expect(page).toHaveURL(/\/emails\/stopped$/);
  await expect(
    page.getByText("You won't get any more trial emails from Squared Away."),
  ).toBeVisible();
  expect(await stopped()).not.toBeNull();
});
