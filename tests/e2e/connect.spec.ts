import { expect, test, type Page } from "@playwright/test";
import { mailboxCount, seedOwner, signInAs } from "./support";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

test("explains what it will and won't do, then sends you to Google with the minimum scopes", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);

  await page.goto("/settings");
  await expect(page.getByText("No Gmail connected yet.")).toBeVisible();
  await page.getByRole("link", { name: "Connect Gmail" }).click();

  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole("heading", { name: "What it won't do" })).toBeVisible();
  await expect(page.getByText(/sending is switched off completely/)).toBeVisible();
  await noHorizontalScroll(page);

  // Stop at Google's door and inspect what we asked for.
  let googleUrl: URL | undefined;
  await page.route("https://accounts.google.com/**", async (route) => {
    googleUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, body: "google consent (stubbed)" });
  });
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByText("google consent (stubbed)")).toBeVisible();

  expect(googleUrl).toBeDefined();
  const scopes = googleUrl!.searchParams.get("scope")!.split(" ");
  expect(scopes).toEqual(
    expect.arrayContaining([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
    ]),
  );
  expect(scopes).toHaveLength(6);
  expect(googleUrl!.searchParams.get("access_type")).toBe("offline");
  expect(googleUrl!.searchParams.get("state")).toBeTruthy();
});

test("a callback with a forged state is rejected", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  await page.goto("/api/gmail/callback?state=forged&code=abc");
  await expect(page).toHaveURL(/\/connect\?error=expired/);
  await expect(page.getByText(/timed out/)).toBeVisible();
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
});

test("disconnect asks once, then removes the mailbox", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);

  await page.goto("/settings");
  await expect(page.getByText(owner.email)).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Disconnect Gmail" }).click();
  await expect(page.getByRole("button", { name: "Keep it connected" })).toBeVisible();
  await page.getByRole("button", { name: "Yes, disconnect Gmail" }).click();

  await expect(page.getByRole("status")).toContainText("Gmail disconnected.");
  await expect(page.getByText("No Gmail connected yet.")).toBeVisible();
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
});
