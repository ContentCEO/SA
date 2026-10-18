/**
 * The whole product, end to end, through the real code (Milestone 11): sign in → Connect Gmail
 * (explainer → Google consent → callback) → read the inbox → sort the email → draft a reply as
 * a real Gmail draft → the owner okays it → undo window → sent, threaded to the customer.
 * And the same on a three-day trial, where nothing can reach a customer.
 *
 * Nothing is seeded but the signed-in owner (and, for the paid test, where they are in the
 * commercial flow). Google, Gmail and the AI model are the local fakes (tests/e2e/fakes),
 * the jobs run through /api/test-hooks/run (the same functions Inngest calls), and every gate
 * runs as in production. Each step title maps to a step of the Google verification demo-video
 * script (docs/google-verification.md; tests/unit/verification-doc.test.ts keeps the two in step).
 *
 * The fake Gmail answers each call only if the token carries a scope Google accepts for it, so
 * these journeys prove the two scopes the app asks for (gmail.readonly and gmail.compose, since
 * 2026-10-15) are enough to read, draft, send the reply and send the practice copy.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { and, count, desc, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { decryptSecret } from "../../src/lib/crypto";
import { replySubject } from "../../src/mailbox/mime";
import {
  SENDING_BLOCKED_MESSAGE,
  sendingBlockedReason,
  sendingOffLabel,
} from "../../src/server/lifecycle";
import { calls, registerScenario, routeGoogleConsent, runHook } from "./fakes/client";
import { FAKE_CLASSIFICATION, fakeCustomer } from "./fakes/outputs";
import { CONNECT_SCOPES, GMAIL_SCOPES, type FakeCall } from "./fakes/server";
import {
  latestDraft,
  mailboxFor,
  newOwnerEmail,
  seedOwner,
  setWorkspace,
  signInAs,
  testDb,
} from "./support";

test.setTimeout(120_000);

type Owner = Awaited<ReturnType<typeof seedOwner>>;
type Scenario = { id: string; ref: string };

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

const only = (all: FakeCall[], route: string) => all.filter((c) => c.route === route);

/** Every address in a header value, lowercased. */
const addresses = (value: string | null | undefined) =>
  [...(value ?? "").matchAll(/[^\s<>,;:"]+@[^\s<>,;:"]+/g)].map((m) => m[0].toLowerCase());

/** Settings → explainer → Google consent → back in the app, mailbox saved. */
async function connectGmail(page: Page, owner: Owner, scenario: Scenario) {
  await test.step("The owner opens Settings → Your Gmail and taps Connect Gmail", async () => {
    await page.goto("/settings");
    await page.getByRole("link", { name: /^Your Gmail/ }).click();
    await expect(page.getByText("No Gmail connected yet.")).toBeVisible();
    await page.getByRole("link", { name: "Connect Gmail" }).click();
  });

  await test.step("Squared Away explains what it will and won't do before asking Google", async () => {
    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole("heading", { name: "What it won't do" })).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole("button", { name: "Connect Gmail" }).click();
  });

  await test.step("Google's consent screen lists the two Gmail permissions; the owner taps Allow", async () => {
    const asked = page.getByRole("list", { name: "Requested access" });
    const gmail = asked.getByRole("listitem").filter({ hasText: "/auth/gmail." });
    await expect(gmail).toHaveText([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    await expect(asked).not.toContainText("gmail.send");
    await page.getByRole("link", { name: "Allow" }).click();
  });

  await test.step("Back in Squared Away, Gmail is connected and its key is stored encrypted", async () => {
    await expect(page).toHaveURL(/\/welcome\/profile$/);
    const mailbox = await mailboxFor(owner.workspaceId);
    expect(mailbox?.email).toBe(owner.email);
    expect(mailbox?.status).toBe("active");
    expect(mailbox!.encryptedRefreshToken).not.toContain(scenario.id);
    expect(decryptSecret(mailbox!.encryptedRefreshToken)).toBe(`rt-${scenario.id}`);
  });
  return (await mailboxFor(owner.workspaceId))!;
}

/** Business profile → reading the inbox and learning the voice → sort → draft. */
async function readSortAndDraft(
  page: Page,
  request: APIRequestContext,
  owner: Owner,
  mailboxId: string,
) {
  await test.step("The owner says what the business does", async () => {
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await page.getByLabel("What's the business called?").fill("Ruiz Street Plumbing");
    await page
      .getByLabel("What work do you take on?")
      .fill("Water heaters, leaks, drains and repipes.");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page).toHaveURL(/\/welcome\/learning$/);
    await noHorizontalScroll(page);
  });

  await test.step("Squared Away reads the last 30 days of email and learns how the owner writes", async () => {
    const backfill = await runHook(request, { step: "backfill", mailboxId });
    expect(backfill).toMatchObject({ ok: true, status: "ok" });
    const voice = await runHook(request, { step: "voice", workspaceId: owner.workspaceId });
    expect(voice).toMatchObject({ ok: true, status: "ready" });
    // The page refreshes itself every 5s; reload rather than race it.
    await page.reload();
    await expect(page.getByText("all set,")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Learned how you write from 5 sent emails.")).toBeVisible();
  });

  await test.step("It sorts the new email and writes a reply as a real Gmail draft", async () => {
    const sorted = await runHook(request, { step: "classify", mailboxId });
    expect(sorted).toMatchObject({ ok: true, classified: 1 });
    const drafted = await runHook(request, { step: "draft", mailboxId });
    expect(drafted).toMatchObject({ ok: true, created: 1 });
  });

  await test.step("A later sync doesn't mistake the Gmail draft for the owner's reply", async () => {
    const synced = await runHook(request, { step: "sync", mailboxId });
    expect(synced).toMatchObject({ ok: true, status: "ok" });
    const row = await latestDraft(owner.workspaceId);
    expect(row?.draft.status).toBe("pending");
    // The draft's Gmail message was seen in history and skipped: the thread still holds only
    // the customer's email, so it's still waiting on the owner.
    const onThread = await testDb
      .select({ direction: schema.messages.direction })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, row!.thread.id));
    expect(onThread.map((m) => m.direction)).toEqual(["in"]);
  });
  return (await latestDraft(owner.workspaceId))!;
}

async function draftCardOnQueue(page: Page) {
  await page.goto("/queue");
  const card = page.getByRole("article", { name: /^Dana.* · draft reply$/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText(FAKE_CLASSIFICATION.summary);
  await noHorizontalScroll(page);
  return card;
}

/** The fakes saw the real thing: OAuth, Gmail reads and drafts, and the model, all of it local. */
function expectCoverage(all: FakeCall[], scenario: Scenario, blocked: string[]) {
  const grants = only(all, "token").map((c) => c.grantType);
  expect(grants).toContain("authorization_code");
  expect(grants).toContain("refresh_token");
  // The consent request asked for exactly the two Gmail scopes (no gmail.send), the token
  // carried exactly those, and the fake Gmail refused nothing for want of a scope.
  const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();
  const consent = only(all, "consent");
  expect(consent.length).toBeGreaterThan(0);
  for (const c of consent) expect(sorted(c.scopes)).toEqual(sorted(CONNECT_SCOPES));
  expect(GMAIL_SCOPES).toEqual([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
  for (const t of only(all, "token")) expect(sorted(t.scopes)).toEqual(sorted(CONNECT_SCOPES));
  expect(all.filter((c) => c.insufficientScope)).toEqual([]);
  for (const route of [
    "consent",
    "userinfo",
    "gmail.profile",
    "gmail.messages.list",
    "gmail.messages.get",
    "gmail.history",
    "gmail.drafts.create",
  ])
    expect(only(all, route).length, route).toBeGreaterThan(0);
  const kinds = only(all, "anthropic.messages").map((c) => c.kind);
  expect(kinds).toEqual(expect.arrayContaining(["classify", "voice", "draft"]));
  expect(kinds.length).toBeGreaterThanOrEqual(3);
  // The app used only the neutral e2e credentials (playwright.config.ts), never a real one.
  expect(all.filter((c) => c.wrongClient)).toEqual([]);
  // Nothing the fakes don't know, and no browser request left for real Google or Anthropic.
  expect(only(all, "unknown")).toEqual([]);
  expect(blocked).toEqual([]);
  // The fakes keep no secrets: no client secret, code or token in what they recorded.
  const recorded = JSON.stringify(all);
  for (const secret of [
    "client_secret",
    "e2e-client-secret",
    `e2e-${scenario.id}`,
    `rt-${scenario.id}`,
    `at-${scenario.id}`,
  ])
    expect(recorded).not.toContain(secret);
}

test("a paid owner connects Gmail and a customer gets one threaded reply", async ({
  page,
  context,
  request,
}) => {
  // The fake first: if it isn't there, fail before writing a (paid) account to the database.
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email);
  const owner = await seedOwner({ email });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "solo",
    setupPaidVia: "stripe",
    setupPaidAt: new Date(),
    setupCallCompletedAt: new Date(),
  });
  await signInAs(context, owner);
  const { blocked } = await routeGoogleConsent(page, context);
  const customer = fakeCustomer(scenario.ref);

  const mailbox = await connectGmail(page, owner, scenario);
  const { draft, thread } = await readSortAndDraft(page, request, owner, mailbox.id);
  expect(thread.gmailThreadId).toBe(customer.gmailThreadId);

  const card = await test.step("The draft waits on the Queue with what the customer wants", () =>
    draftCardOnQueue(page));

  await test.step("The owner taps Send reply and gets a few seconds to undo it", async () => {
    await card.getByRole("button", { name: "Send reply" }).click();
    await expect(page).toHaveURL(new RegExp(`/queue\\?sent=${draft.id}`));
    await expect(page.getByText("reply on its way,")).toBeVisible();
    await expect(page.getByText(/Sending in \d+ seconds/)).toBeVisible();
    // Check 32 P7: focus is on the result, and the next Tab is Undo.
    await expect(page.getByTestId("sent-strip")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Undo" })).toBeFocused();
    await noHorizontalScroll(page);
    // Nothing goes early: the undo window is real.
    expect(await runHook(request, { step: "deliver", draftId: draft.id })).toMatchObject({
      ok: false,
      status: "not_due",
    });
    expect(only(await calls(request, scenario.id), "gmail.drafts.send")).toHaveLength(0);
  });

  await test.step("When the window ends the reply goes, and the screen says squared away.", async () => {
    await expect
      .poll(async () => (await runHook(request, { step: "deliver", draftId: draft.id })).status, {
        timeout: 45_000,
        intervals: [2_000],
      })
      .toBe("sent");
    // Once sent, it can't go again: a second delivery finds nothing to claim.
    expect(await runHook(request, { step: "deliver", draftId: draft.id })).toMatchObject({
      ok: false,
      status: "not_due",
    });
    // The screen checks back every 3s on its own.
    await expect(page.getByText("squared away.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("reply sent,")).toBeVisible();
  });

  await test.step("Activity says the reply was sent", async () => {
    await page.goto("/activity");
    await expect(page.getByText("You sent a reply to Dana").first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  await test.step("Gmail sent exactly one email: the reply, to the customer, in their conversation", async () => {
    const all = await calls(request, scenario.id);
    const sends = only(all, "gmail.drafts.send");
    expect(sends).toHaveLength(1);
    expect(only(all, "gmail.messages.send")).toHaveLength(0);
    const mail = sends[0]!.mail!;
    expect(addresses(mail.from)).toEqual([owner.email]);
    expect(addresses(mail.to)).toEqual([customer.email]);
    expect(mail.cc).toBeNull();
    expect(mail.bcc).toBeNull();
    expect(mail.subject).toBe(replySubject(customer.subject));
    expect(mail.inReplyTo).toBe(customer.messageIdHeader);
    expect(mail.references).toContain(customer.messageIdHeader);
    expect(mail.threadId).toBe(customer.gmailThreadId);
    expectCoverage(all, scenario, blocked);
    expect(only(all, "gmail.drafts.get").length).toBeGreaterThan(0);

    const [sent] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(sent?.status).toBe("sent");
    const [logged] = await testDb
      .select({ n: count() })
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.workspaceId, owner.workspaceId),
          eq(schema.activityLog.action, "reply_sent"),
        ),
      );
    expect(logged?.n).toBe(1);
  });

  await test.step("The next sync sees the owner answered, so nothing new is drafted", async () => {
    // The send itself stored the sent email as the owner's (recordSentMessage), under the id
    // Gmail gave it.
    const [sentDraft] = await testDb
      .select({ sentGmailMessageId: schema.drafts.sentGmailMessageId })
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    const sentId = sentDraft?.sentGmailMessageId;
    expect(sentId).toBeTruthy();
    const sentRow = and(
      eq(schema.messages.mailboxId, mailbox.id),
      eq(schema.messages.gmailMessageId, sentId!),
    );
    const recorded = await testDb
      .select({ direction: schema.messages.direction })
      .from(schema.messages)
      .where(sentRow);
    expect(recorded).toEqual([{ direction: "out" }]);

    // Now the sync has to prove it on its own, as for a reply the owner sent from Gmail itself:
    // forget that row, so only Gmail's history can bring it back.
    await testDb.delete(schema.messages).where(sentRow);
    const before = (await calls(request, scenario.id)).length;
    expect(await runHook(request, { step: "sync", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      status: "ok",
      ingested: 1,
    });
    const bySync = (await calls(request, scenario.id)).slice(before);
    expect(only(bySync, "gmail.history").length).toBeGreaterThan(0);
    expect(
      only(bySync, "gmail.messages.get").some((c) => c.path.endsWith(`/messages/${sentId}`)),
    ).toBe(true);
    const [resynced] = await testDb
      .select({
        direction: schema.messages.direction,
        labelIds: schema.messages.labelIds,
        threadId: schema.messages.threadId,
      })
      .from(schema.messages)
      .where(sentRow);
    expect(resynced?.direction).toBe("out");
    expect(resynced?.labelIds).toContain("SENT");
    expect(resynced?.labelIds).not.toContain("DRAFT");
    expect(resynced?.threadId).toBe(thread.id);

    expect(await runHook(request, { step: "draft", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      created: 0,
    });
    const [newest] = await testDb
      .select({ direction: schema.messages.direction })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, thread.id))
      .orderBy(desc(schema.messages.sentAt))
      .limit(1);
    expect(newest?.direction).toBe("out");
    const onThread = await testDb
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(eq(schema.drafts.threadId, thread.id));
    expect(onThread).toHaveLength(1);
  });

  await test.step("Delete my account: Google access is revoked and nothing of theirs is left", async () => {
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await page.getByRole("button", { name: "Yes, delete everything" }).click();
    await expect(page).toHaveURL(/\/goodbye$/);
    expect(only(await calls(request, scenario.id), "revoke")).toHaveLength(1);
    const left = await Promise.all([
      testDb.select().from(schema.users).where(eq(schema.users.id, owner.userId)),
      testDb.select().from(schema.workspaces).where(eq(schema.workspaces.id, owner.workspaceId)),
      testDb.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, mailbox.id)),
      testDb.select().from(schema.threads).where(eq(schema.threads.mailboxId, mailbox.id)),
      testDb.select().from(schema.messages).where(eq(schema.messages.mailboxId, mailbox.id)),
      testDb.select().from(schema.drafts).where(eq(schema.drafts.mailboxId, mailbox.id)),
      testDb
        .select()
        .from(schema.activityLog)
        .where(eq(schema.activityLog.workspaceId, owner.workspaceId)),
    ]);
    expect(left.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

test("a trial owner sees the draft but nothing can be sent to the customer", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email);
  const owner = await seedOwner({ email });
  await signInAs(context, owner);
  const { blocked } = await routeGoogleConsent(page, context);
  const customer = fakeCustomer(scenario.ref);

  const mailbox = await connectGmail(page, owner, scenario);
  await test.step("Connecting Gmail starts the three-day trial", async () => {
    const [w] = await testDb
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, owner.workspaceId));
    expect(w?.status).toBe("evaluating");
    expect(w?.evaluationEndsAt?.getTime()).toBeGreaterThan(Date.now());
  });
  const { draft } = await readSortAndDraft(page, request, owner, mailbox.id);

  const card = await test.step("On the trial account the draft waits on the Queue", () =>
    draftCardOnQueue(page));

  await test.step("During the trial the card says sending is off, and there's no Send reply", async () => {
    const [w] = await testDb
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, owner.workspaceId));
    await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
    const note = card.getByRole("note");
    await expect(note).toContainText(sendingOffLabel(w!));
    await expect(note).toContainText(sendingBlockedReason(w!));
    await expect(card.getByRole("button", { name: "Send it to yourself instead" })).toBeVisible();
  });

  await test.step("Asking the server to send anyway is refused (403)", async () => {
    const res = await page.request.post(`/api/drafts/${draft.id}/send`, {
      headers: { origin: baseURL! },
      data: {},
    });
    // The trial gate's 403, not the cross-site check's.
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: SENDING_BLOCKED_MESSAGE });
    const [row] = await testDb
      .select({ sendAfter: schema.drafts.sendAfter, status: schema.drafts.status })
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(row).toEqual({ sendAfter: null, status: "pending" });
    expect(await runHook(request, { step: "deliver", draftId: draft.id })).toMatchObject({
      ok: false,
      status: "not_due",
    });
  });

  await test.step("The owner sends a practice copy to their own inbox instead", async () => {
    await card.getByRole("button", { name: "Send it to yourself instead" }).click();
    await expect(page).toHaveURL(/\/queue\?done=practice/);
    await expect(page.getByText(/Practice copy sent to your own inbox/)).toBeVisible();
    await noHorizontalScroll(page);
  });

  await test.step("Gmail sent only the practice copy, to the owner; the customer got nothing", async () => {
    const all = await calls(request, scenario.id);
    expect(only(all, "gmail.drafts.send")).toHaveLength(0);
    const practice = only(all, "gmail.messages.send");
    expect(practice).toHaveLength(1);
    const mail = practice[0]!.mail!;
    expect(addresses(mail.to)).toEqual([owner.email]);
    expect(mail.cc).toBeNull();
    expect(mail.bcc).toBeNull();
    expect(mail.subject?.startsWith("[Practice]")).toBe(true);
    expect(mail.threadId).toBeNull();
    const recipients = all.flatMap((c) =>
      c.mail ? [...addresses(c.mail.to), ...addresses(c.mail.cc), ...addresses(c.mail.bcc)] : [],
    );
    expect(recipients).not.toContain(customer.email);
    expectCoverage(all, scenario, blocked);

    const [still] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(still?.status).toBe("pending");
  });
});
