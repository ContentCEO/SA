/**
 * Review "Must fix" (B1 + H7), end to end: a lead from a website contact form (Squarespace's
 * layout: the form's robot address in From, the customer in Reply-To) is answered at the
 * customer's own address. The card says where the reply goes before the owner taps Send reply,
 * and Gmail sends exactly one email — to the customer, never to the robot.
 *
 * Same fakes and hooks as full-flow.spec.ts: Google, Gmail and the AI model are local, the
 * jobs run through /api/test-hooks/run, and every gate runs as in production.
 */
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { replySubject } from "../../src/mailbox/mime";
import { calls, registerScenario, routeGoogleConsent, runHook } from "./fakes/client";
import { fakeCustomer, FORM_ROBOT } from "./fakes/outputs";
import type { FakeCall } from "./fakes/server";
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

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

const only = (all: FakeCall[], route: string) => all.filter((c) => c.route === route);
const addresses = (value: string | null | undefined) =>
  [...(value ?? "").matchAll(/[^\s<>,;:"]+@[^\s<>,;:"]+/g)].map((m) => m[0].toLowerCase());

test("a website form lead is answered at the customer's own address, not the form's", async ({
  page,
  context,
  request,
}) => {
  const email = newOwnerEmail();
  const scenario = await registerScenario(request, email, {}, { lead: "form" });
  const owner = await seedOwner({ email });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "solo",
    setupPaidVia: "stripe",
    setupPaidAt: new Date(),
    setupCallCompletedAt: new Date(),
  });
  await signInAs(context, owner);
  await routeGoogleConsent(page, context);
  const customer = fakeCustomer(scenario.ref, "form");

  await test.step("The owner connects Gmail", async () => {
    await page.goto("/connect");
    await page.getByRole("button", { name: "Connect Gmail" }).click();
    await page.getByRole("link", { name: "Allow" }).click();
    await expect(page).toHaveURL(/\/welcome\/profile$/);
  });
  const mailbox = (await mailboxFor(owner.workspaceId))!;

  await test.step("Sync reads the form email's Reply-To; it's sorted and drafted", async () => {
    expect(await runHook(request, { step: "backfill", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      status: "ok",
    });
    const [stored] = await testDb
      .select({
        fromAddress: schema.messages.fromAddress,
        replyToHeader: schema.messages.replyToHeader,
      })
      .from(schema.messages)
      .where(eq(schema.messages.gmailMessageId, customer.gmailMessageId));
    expect(stored).toEqual({
      fromAddress: FORM_ROBOT.email,
      replyToHeader: { address: customer.email, name: "Dana Ruiz" },
    });
    expect(await runHook(request, { step: "classify", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      classified: 1,
    });
    expect(await runHook(request, { step: "draft", mailboxId: mailbox.id })).toMatchObject({
      ok: true,
      created: 1,
    });
    const row = await latestDraft(owner.workspaceId);
    expect(row?.draft.toAddress).toBe(customer.email);
    // Every metadata read asked Gmail for Reply-To.
    const metadata = only(await calls(request, scenario.id), "gmail.messages.get").filter(
      (c) => c.metadataHeaders,
    );
    expect(metadata.length).toBeGreaterThan(0);
    for (const c of metadata) expect(c.metadataHeaders).toContain("Reply-To");
  });

  const card = page.getByRole("article", { name: /^Dana Ruiz.* · draft reply$/ });
  await test.step("The card names Dana and says the reply goes to her own address", async () => {
    await page.goto("/queue");
    await expect(card).toBeVisible();
    await expect(card).toContainText(`To: ${customer.email}`);
    await expect(card).toContainText("the reply address in their email");
    await expect(card).not.toContainText(FORM_ROBOT.email);
    await noHorizontalScroll(page);
  });

  await test.step("Send reply: after the undo window, Gmail sends one email, to Dana", async () => {
    await card.getByRole("button", { name: "Send reply" }).click();
    const draft = (await latestDraft(owner.workspaceId))!.draft;
    await expect(page).toHaveURL(new RegExp(`/queue\\?sent=${draft.id}`));
    await noHorizontalScroll(page);
    await expect
      .poll(async () => (await runHook(request, { step: "deliver", draftId: draft.id })).status, {
        timeout: 45_000,
        intervals: [2_000],
      })
      .toBe("sent");
    const sends = only(await calls(request, scenario.id), "gmail.drafts.send");
    expect(sends).toHaveLength(1);
    const mail = sends[0]!.mail!;
    expect(addresses(mail.to)).toEqual([customer.email]);
    expect(addresses(mail.to)).not.toContain(FORM_ROBOT.email);
    expect(mail.cc).toBeNull();
    expect(mail.bcc).toBeNull();
    expect(mail.subject).toBe(replySubject(customer.subject));
    expect(mail.inReplyTo).toBe(customer.messageIdHeader);
    expect(mail.threadId).toBe(customer.gmailThreadId);
  });
});
