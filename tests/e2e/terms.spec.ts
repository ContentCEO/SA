import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import {
  AGREE_REQUIRED_MESSAGE,
  TERMS_COOKIE,
  TERMS_REQUIRED_API_MESSAGE,
  TERMS_VERSION,
} from "../../src/config/legal";
import { mailboxCount, seedOwner, signInAs, testDb } from "./support";

/**
 * The "I agree" boxes (Davi, 2026-10-15): sign-in needs the box (the server refuses without it),
 * and an account that hasn't agreed to the current terms is held on /welcome/terms — every
 * screen sends it there, API calls get a 403 — until it agrees.
 */

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

async function atLeast44High(target: Locator) {
  const box = await target.boundingBox();
  expect(box, "visible").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

const agreeBox = (page: Page) =>
  page.getByRole("checkbox", {
    name: "I agree to the Terms of Service and the Privacy Policy.",
  });

/** The form's error (Next's own route announcer is an empty role=alert too). */
const errorLine = (page: Page) => page.getByRole("alert").filter({ hasText: "Tick the box" });

async function termsOf(userId: string) {
  const [row] = await testDb
    .select({ at: schema.users.termsAcceptedAt, version: schema.users.termsVersion })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row!;
}

test("sign-in without the box: a plain error, focus on the box, and still on /signin", async ({
  page,
  context,
}) => {
  let wentToGoogle = false;
  await page.route("https://accounts.google.com/**", async (route) => {
    wentToGoogle = true;
    await route.fulfill({ status: 200, body: "google consent (stubbed)" });
  });
  await page.goto("/signin");
  await expect(agreeBox(page)).not.toBeChecked();
  await expect(page.getByRole("link", { name: "Terms of Service" }).first()).toHaveAttribute(
    "href",
    "/terms",
  );
  await expect(page.getByRole("link", { name: "Privacy Policy" }).first()).toHaveAttribute(
    "href",
    "/privacy",
  );
  await atLeast44High(page.locator("label").filter({ has: agreeBox(page) }));
  await atLeast44High(page.getByRole("button", { name: "Sign in with Google" }));
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(errorLine(page)).toHaveText(AGREE_REQUIRED_MESSAGE);
  await expect(agreeBox(page)).toBeFocused();
  await expect(page).toHaveURL(/\/signin$/);
  expect(wentToGoogle).toBe(false);
  expect((await context.cookies()).some((c) => c.name === TERMS_COOKIE)).toBe(false);
  await noHorizontalScroll(page);
});

test("sign-in with the box goes on to Google, carrying the agreement in a short-lived cookie", async ({
  page,
  context,
}) => {
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, body: "google consent (stubbed)" }),
  );
  await page.goto("/signin");
  await agreeBox(page).check();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByText("google consent (stubbed)")).toBeVisible();

  const cookie = (await context.cookies()).find((c) => c.name === TERMS_COOKIE);
  expect(cookie).toBeDefined();
  expect(cookie!.value).toBe(TERMS_VERSION);
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe("Lax");
  expect(cookie!.path).toBe("/api/auth");
  // Minutes, not a session-long cookie.
  expect(cookie!.expires * 1000 - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);
});

test("an account that hasn't agreed is held on /welcome/terms until it does", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner, { agreedToTerms: false });

  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fqueue$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("one thing first,");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("the fine print.");
  await noHorizontalScroll(page);

  // No way round it: another screen, and the queue again.
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fsettings$/);
  await page.goto("/more");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fmore$/);
  await page.goto("/settings/follow-ups");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fsettings%2Ffollow-ups$/);
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fqueue$/);

  // API calls are refused with a 403, not redirected.
  const badge = await page.request.get("/api/badge", { maxRedirects: 0 });
  expect(badge.status()).toBe(403);
  expect(await badge.json()).toEqual({
    error: TERMS_REQUIRED_API_MESSAGE,
    status: "terms_required",
  });

  // The button without the box: refused on the server, nothing recorded.
  const agreeButton = page.getByRole("button", { name: "Agree and continue" });
  await atLeast44High(agreeButton);
  await atLeast44High(page.getByRole("button", { name: "Sign out", exact: true }));
  await atLeast44High(page.locator("label").filter({ has: agreeBox(page) }));
  await agreeButton.click();
  await expect(errorLine(page)).toHaveText(AGREE_REQUIRED_MESSAGE);
  await expect(agreeBox(page)).toBeFocused();
  expect((await termsOf(owner.userId)).version).toBeNull();

  await agreeBox(page).check();
  await agreeButton.click();
  await expect(page).toHaveURL(/\/queue$/);
  const row = await termsOf(owner.userId);
  expect(row.version).toBe(TERMS_VERSION);
  expect(row.at).not.toBeNull();
  expect((await page.request.get("/api/badge")).status()).toBe(200);

  // Agreed: the terms screen sends them straight on.
  await page.goto("/welcome/terms?next=%2Fsettings");
  await expect(page).toHaveURL(/\/settings$/);
});

test("after the terms change, the screen says so, and it goes back where they were heading", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await testDb
    .update(schema.users)
    .set({ termsVersion: "2020-01-01" })
    .where(eq(schema.users.id, owner.userId));

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fsettings$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("our terms.");
  await agreeBox(page).check();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect((await termsOf(owner.userId)).version).toBe(TERMS_VERSION);
});

test("someone who doesn't agree can sign out from the terms screen", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner, { agreedToTerms: false });
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms/);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/signin$/);
});

test("someone who doesn't agree can still disconnect Gmail and delete their account", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner, { agreedToTerms: false });
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms/);
  const leave = page.getByRole("region", { name: "Don't agree?" });
  await expect(leave).toContainText("delete your account right here");
  await atLeast44High(leave.getByRole("button", { name: "Disconnect Gmail" }));
  await atLeast44High(leave.getByRole("button", { name: "Delete my account" }));

  // Disconnect: the same one confirmation as Settings, then back here (still not agreed).
  await leave.getByRole("button", { name: "Disconnect Gmail" }).click();
  await atLeast44High(leave.getByRole("button", { name: "Yes, disconnect Gmail" }));
  await noHorizontalScroll(page);
  await leave.getByRole("button", { name: "Yes, disconnect Gmail" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gmail disconnected." })).toBeVisible();
  await expect(page).toHaveURL(/\/welcome\/terms\?done=disconnected$/);
  expect(await mailboxCount(owner.workspaceId)).toBe(0);
  await expect(leave.getByRole("button", { name: "Disconnect Gmail" })).toHaveCount(0);

  // Delete my account: one confirmation, then everything is gone.
  await leave.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("form", { name: "Delete my account" });
  await expect(confirm).toContainText("This can't be undone");
  await noHorizontalScroll(page);
  await confirm.getByLabel("Type DELETE to confirm").fill("delete");
  await confirm.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page).toHaveURL(/\/goodbye$/);
  expect(
    await testDb.select().from(schema.users).where(eq(schema.users.id, owner.userId)),
  ).toHaveLength(0);
});

test("a link back to another site is never followed", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner, { agreedToTerms: false });
  await page.goto("/welcome/terms?next=https%3A%2F%2Fevil.example%2F");
  await agreeBox(page).check();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/queue$/);
});

test("an owner on an older version is told what changed (Check 27 P3)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  // The first version anyone agreed to: every later entry in docs/legal-changes.md applies.
  await testDb
    .update(schema.users)
    .set({ termsVersion: "2026-10-15" })
    .where(eq(schema.users.id, owner.userId));

  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fqueue$/);
  const changed = page.getByRole("region", { name: "What changed" });
  await expect(changed.getByRole("heading", { level: 2, name: "What changed" })).toBeVisible();
  expect(await changed.getByRole("listitem").count()).toBeGreaterThanOrEqual(2);
  await expect(changed).toContainText("two Gmail permissions");
  await noHorizontalScroll(page);

  // Someone who never agreed reads the whole documents: no list.
  await signInAs(context, owner, { agreedToTerms: false });
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/welcome\/terms\?next=%2Fqueue$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("one thing first,");
  await expect(page.getByRole("heading", { name: "What changed" })).toHaveCount(0);
});
