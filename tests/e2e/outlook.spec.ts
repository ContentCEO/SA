import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { decryptSecret } from "../../src/lib/crypto";
import { SENDING_BLOCKED_MESSAGE } from "../../src/server/lifecycle";
import {
  outlookRecord,
  registerOutlookScenario,
  routeMicrosoftSignIn,
  runHook,
} from "./fakes/client";
import { OUTLOOK_LEAD, OUTLOOK_SCOPES } from "./fakes/microsoft";
import {
  latestDraft,
  mailboxFor,
  newOwnerEmail,
  seedOwner,
  setWorkspace,
  signInAs,
  testDb,
} from "./support";

/**
 * Plan #49: Outlook / Microsoft 365, on the second e2e app where FEATURE_OUTLOOK is on
 * (playwright.config.ts, project "outlook"). Connect through Microsoft's (fake) sign-in, sync a
 * thread, a reply appears as a real Outlook draft, the send gate holds during the trial (403, no
 * send at Microsoft) and opens once setup is paid, then Disconnect.
 */

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

test("an owner connects Outlook, gets a draft, can't send on the trial, sends once paid, and disconnects", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const email = newOwnerEmail();
  const scenario = await registerOutlookScenario(request, email);
  const owner = await seedOwner({ email });
  await signInAs(context, owner);
  const { blocked } = await routeMicrosoftSignIn(page, context);

  await test.step("The Connect screen offers Outlook with Microsoft's permissions explained", async () => {
    await page.goto("/connect");
    await expect(page).toHaveTitle(/Connect your email/);
    await expect(page.getByRole("button", { name: "Connect Gmail" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Email on Outlook or Microsoft 365?" }),
    ).toBeVisible();
    await expect(page.getByText("Read and write access to your mail")).toBeVisible();
    await expect(page.getByText("Send mail as you")).toBeVisible();
    await noHorizontalScroll(page);
    const button = page.getByRole("button", { name: "Connect Outlook" });
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await button.click();
  });

  await test.step("Microsoft's sign-in asks for exactly the four permissions; the owner accepts", async () => {
    const asked = page.getByRole("list", { name: "Requested permissions" });
    await expect(asked.getByRole("listitem")).toHaveText(OUTLOOK_SCOPES);
    await page.getByRole("link", { name: "Accept" }).click();
    await expect(page).toHaveURL(/\/welcome\/profile$/);
  });

  const mailbox = (await mailboxFor(owner.workspaceId))!;
  await test.step("Saved as an Outlook mailbox, its key encrypted; the trial has started", async () => {
    expect(mailbox).toMatchObject({ provider: "outlook", email, status: "active" });
    expect(mailbox.encryptedRefreshToken).not.toMatch(/^rt-/);
    expect(decryptSecret(mailbox.encryptedRefreshToken)).toMatch(/^rt-/);
    const [w] = await testDb
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, owner.workspaceId));
    expect(w?.status).toBe("evaluating");
  });

  await test.step("The inbox is read, the email sorted, and a reply written as an Outlook draft", async () => {
    expect(await runHook(request, { step: "backfill", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      status: "ok",
    });
    expect(await runHook(request, { step: "voice", workspaceId: owner.workspaceId })).toMatchObject(
      { ok: true, status: "ready" },
    );
    expect(await runHook(request, { step: "classify", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      classified: 1,
    });
    expect(await runHook(request, { step: "draft", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      created: 1,
    });
    // A sync afterwards takes no draft for mail and stores nothing twice.
    expect(await runHook(request, { step: "sync", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
    });
  });

  const { draft, thread } = (await latestDraft(owner.workspaceId))!;
  await test.step("The draft is a real Outlook draft in the customer's conversation", async () => {
    expect(thread.subject).toBe(OUTLOOK_LEAD.subject);
    expect(draft.toAddress).toBe(OUTLOOK_LEAD.from.address);
    const rec = await outlookRecord(request, scenario.id);
    expect(rec.drafts).toEqual([{ id: draft.gmailDraftId, conversationId: thread.gmailThreadId }]);
    const messages = await testDb
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.mailboxId, mailbox.id));
    // The lead and the five earlier sent replies; never the draft.
    expect(messages.map((m) => m.gmailMessageId)).not.toContain(draft.gmailDraftId);
    expect(messages.filter((m) => m.threadId === thread.id)).toHaveLength(1);
    await page.goto("/queue");
    await expect(page.getByRole("article", { name: /^Dana.* · draft reply$/ })).toBeVisible();
    await noHorizontalScroll(page);
  });

  await test.step("During the trial a send is refused (403) and nothing reaches Microsoft", async () => {
    const res = await page.request.post(`/api/drafts/${draft.id}/send`, {
      headers: { origin: baseURL! },
      data: {},
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: SENDING_BLOCKED_MESSAGE });
    const rec = await outlookRecord(request, scenario.id);
    expect(rec.sends).toEqual([]);
    expect(rec.calls.filter((c) => /\/send$/.test(c.path))).toEqual([]);
  });

  await test.step("Once setup is paid the same tap sends it through Microsoft, once", async () => {
    await setWorkspace(owner.workspaceId, {
      status: "active",
      plan: "solo",
      setupPaidVia: "stripe",
      setupPaidAt: new Date(),
      setupCallCompletedAt: new Date(),
    });
    const res = await page.request.post(`/api/drafts/${draft.id}/send`, {
      headers: { origin: baseURL! },
      data: {},
    });
    expect(res.status()).toBe(202);
    await expect
      .poll(async () => (await runHook(request, { step: "deliver", draftId: draft.id })).status, {
        timeout: 45_000,
        intervals: [2_000],
      })
      .toBe("sent");
    const rec = await outlookRecord(request, scenario.id);
    expect(rec.sends).toEqual([
      expect.objectContaining({
        id: draft.gmailDraftId,
        to: [OUTLOOK_LEAD.from.address],
        conversationId: thread.gmailThreadId,
      }),
    ]);
    // Every Graph request asked for immutable ids, and none was refused for a permission.
    expect(
      rec.calls.filter((c) => c.path !== "/token" && c.path !== "/authorize" && c.noImmutableId),
    ).toEqual([]);
    expect(rec.calls.filter((c) => c.insufficientScope)).toEqual([]);
    const [sent] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(sent!.status).toBe("sent");
  });

  await test.step("Disconnect deletes the mailbox and says where to remove the app at Microsoft", async () => {
    await page.goto("/settings/gmail");
    await page.getByRole("button", { name: "Disconnect Outlook" }).click();
    await expect(
      page.getByText(/Microsoft doesn't let apps remove their own access/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Yes, disconnect Outlook" }).click();
    await expect(page).toHaveURL(/done=disconnected_outlook/);
    await expect(page.getByText(/Outlook disconnected\..*account\.microsoft\.com/)).toBeVisible();
    expect(await mailboxFor(owner.workspaceId)).toBeUndefined();
  });

  // Nothing in the browser went to a real Microsoft host.
  expect(blocked).toEqual([]);
});
