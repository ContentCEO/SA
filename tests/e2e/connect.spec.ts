import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { calls, registerScenario, routeGoogleConsent } from "./fakes/client";
import { mailboxCount, mailboxFor, newOwnerEmail, seedOwner, signInAs, testDb } from "./support";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
/** Dropped on 2026-10-15: never asked for, but an older connection's grant may still carry it. */
const SEND = "https://www.googleapis.com/auth/gmail.send";

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
  await page.getByRole("link", { name: /^Your Gmail/ }).click();
  await expect(page).toHaveURL(/\/settings\/gmail$/);
  await expect(page.getByText("No Gmail connected yet.")).toBeVisible();
  await page.getByRole("link", { name: "Connect Gmail" }).click();

  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole("heading", { name: "What it won't do" })).toBeVisible();
  await expect(
    page.getByText(
      /Squared Away won't send anything to a customer: from Squared Away you can only send yourself practice copies/,
    ),
  ).toBeVisible();
  // The two permissions in Google's own words, and the Send reply promise.
  await expect(page.getByText("Google will ask you to allow two things")).toBeVisible();
  await expect(page.getByText("View your email messages and settings")).toBeVisible();
  await expect(page.getByText("Manage drafts and send emails")).toBeVisible();
  await expect(
    page.getByText(
      /it still goes out only when you tap Send reply \(or by autopilot, if you switch it on for a kind of email\)/,
    ),
  ).toBeVisible();
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
  expect([...scopes].sort()).toEqual(["email", "openid", "profile", COMPOSE, READONLY].sort());
  expect(scopes).not.toContain(SEND);
  expect(googleUrl!.searchParams.get("access_type")).toBe("offline");
  expect(googleUrl!.searchParams.get("state")).toBeTruthy();
});

test("unticking a Gmail permission on Google's screen saves nothing and hands the access back", async ({
  page,
  context,
  request,
}) => {
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email, { untick: [COMPOSE] });
  const owner = await seedOwner({ email });
  await signInAs(context, owner);
  const { blocked } = await routeGoogleConsent(page, context);

  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await page.getByRole("link", { name: "Allow" }).click();

  await expect(page).toHaveURL(/\/connect\?error=scopes$/);
  await expect(page.getByText(/Squared Away needs both to work/)).toBeVisible();
  await noHorizontalScroll(page);
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
  const [w] = await testDb
    .select({ status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w?.status).toBe("invited");
  const all = await calls(request, scenario.id);
  const routes = all.map((c) => c.route);
  expect(routes).toEqual(["consent", "token", "revoke"]);
  expect(all[1]!.scopes).not.toContain(COMPOSE);
  expect(blocked).toEqual([]);
});

test("a Google account without Gmail is refused plainly and the trial doesn't start (Check 47 P1)", async ({
  page,
  context,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email, {}, { noGmail: true });
  const owner = await seedOwner({ email });
  await signInAs(context, owner);
  const { blocked } = await routeGoogleConsent(page, context);

  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await page.getByRole("link", { name: "Allow" }).click();

  await expect(page).toHaveURL(/\/connect\?error=no_gmail$/);
  await expect(page.getByRole("alert")).toContainText(
    "This Google account doesn't have Gmail, so there's nothing for Squared Away to read.",
  );
  await noHorizontalScroll(page);
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
  const [w] = await testDb
    .select({ status: schema.workspaces.status, ends: schema.workspaces.evaluationEndsAt })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w).toEqual({ status: "invited", ends: null });
  const routes = (await calls(request, scenario.id)).map((c) => c.route);
  expect(routes).toEqual(["consent", "token", "gmail.profile", "revoke"]);
  expect(blocked).toEqual([]);
});

test("an owner whose older grant still carries gmail.send connects as usual", async ({
  page,
  context,
  request,
}) => {
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email, { earlier: [SEND] });
  const owner = await seedOwner({ email });
  await signInAs(context, owner);
  const { blocked } = await routeGoogleConsent(page, context);

  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await page.getByRole("link", { name: "Allow" }).click();

  await expect(page).toHaveURL(/\/welcome\/profile$/);
  const mailbox = await mailboxFor(owner.workspaceId);
  expect(mailbox?.status).toBe("active");
  expect(mailbox?.scopes.split(" ")).toEqual(expect.arrayContaining([READONLY, COMPOSE, SEND]));
  const all = await calls(request, scenario.id);
  // We asked for the two only; Google added the old one back to the grant.
  const consent = all.find((c) => c.route === "consent");
  expect(consent?.scopes).toEqual(expect.arrayContaining([READONLY, COMPOSE]));
  expect(consent?.scopes).not.toContain(SEND);
  expect(all.find((c) => c.route === "token")?.scopes).toContain(SEND);
  expect(all.map((c) => c.route)).not.toContain("revoke");
  expect(blocked).toEqual([]);
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

  await page.goto("/settings/gmail");
  await expect(page.getByText(owner.email)).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Disconnect Gmail" }).click();
  await expect(page.getByRole("button", { name: "Keep it connected" })).toBeVisible();
  await page.getByRole("button", { name: "Yes, disconnect Gmail" }).click();

  await expect(page.getByRole("status")).toContainText("Gmail disconnected.");
  await expect(page.getByText("No Gmail connected yet.")).toBeVisible();
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
});
