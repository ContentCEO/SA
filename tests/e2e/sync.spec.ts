import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

test("while the first read is running, Settings says so plainly", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  await page.goto("/settings");
  await expect(page.getByText(/Reading your last 30 days of email/)).toBeVisible();
});

test("after the backfill, Settings shows how much was read and when", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true, messageCount: 3 });
  await signInAs(context, owner);
  await page.goto("/settings");
  await expect(page.getByText("3 emails from the last 30 days, checked just now.")).toBeVisible();
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
  await page.goto("/settings");
  await expect(page.getByText("Needs reconnecting")).toBeVisible();
});

test("Gmail push rejects requests without the shared token", async ({ request }) => {
  const res = await request.post("/api/gmail/push", { data: { message: { data: "" } } });
  expect(res.status()).toBe(403);
});
