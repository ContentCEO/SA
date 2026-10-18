import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

/**
 * Waits until the page has hydrated and stopped scrolling (two reads 250ms apart agree), so a
 * check of where a card ended up can't pass on a reading taken part-way through a scroll.
 */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect
    .poll(async () => {
      const a = await page.evaluate(() => window.scrollY);
      await page.waitForTimeout(250);
      return (await page.evaluate(() => window.scrollY)) === a;
    })
    .toBe(true);
}

test("queue: needs-you first, then drafts; sending is off until setup, and it says so", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);

  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByText("Customer says the leak came back.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a reply" })).toBeVisible();

  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(card).toContainText("Asked for the address and panel age.");
  await expect(card).toContainText("Panel upgrade quote."); // what they want, at a glance
  await expect(card).toContainText("Check you can do Tuesday morning.");
  // The Send button is replaced by an explanation, not hidden.
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card.getByRole("note")).toContainText("Sending isn't on yet");
  // Check 43 P3: who the customer sees as the sender, above To.
  await expect(card).toContainText("From:");
  // Check 43 P5: the subject the customer will see, above the reply.
  await expect(card).toContainText("Subject: Re: Panel");
  // Check 43 P4: no signature saved → one line under the first draft, linking to the field.
  await expect(card).toContainText("No signature. Customers won't see your phone number.");
  await expect(card.getByRole("link", { name: "Add a signature" })).toHaveAttribute(
    "href",
    "/settings/profile#signature",
  );

  await card.getByRole("button", { name: "Show full draft" }).click();
  await expect(card).toContainText("how old is the current panel?");
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(card.getByLabel("Your reply")).toHaveValue(/What's the address/);
  await expect(card.getByRole("button", { name: "Save changes" })).toBeVisible();
  // The rewrites live behind Change it now, not in the editor.
  await expect(card.getByLabel("Tell it what to change")).toHaveCount(0);
  await card.getByRole("button", { name: "Cancel" }).click();
  // Outside review: the five tweaks and "Tell it what to change" sit behind one button.
  const tweaks = card.getByRole("form", { name: "Quick changes" });
  await expect(tweaks).toHaveCount(0);
  const changeIt = card.getByRole("button", { name: "Change it" });
  await expect(changeIt).toHaveAttribute("aria-expanded", "false");
  await changeIt.click();
  await expect(changeIt).toHaveAttribute("aria-expanded", "true");
  // Plan #3: one-tap tweaks.
  for (const name of ["Shorter", "Warmer", "More formal", "Ask for photos", "Add my availability"])
    await expect(tweaks.getByRole("button", { name })).toBeVisible();
  // Plan #4: a change can be said or typed; the button appears once there's something to use.
  await expect(card.getByLabel("Tell it what to change")).toBeVisible();
  await expect(card.getByRole("button", { name: "Change the draft" })).toHaveCount(0);
  await card.getByLabel("Tell it what to change").fill("make it Tuesday");
  await expect(card.getByRole("button", { name: "Change the draft" })).toBeVisible();
  await changeIt.click();
  await expect(tweaks).toHaveCount(0);

  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card.getByRole("button", { name: "Discard draft" })).toBeVisible();
  await card.getByRole("button", { name: "Keep it" }).click();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("Check 43 P4: an owner with a signature sees no 'No signature' line", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await testDb
    .insert(schema.businessProfiles)
    .values({ workspaceId: owner.workspaceId, signature: "Davi\n978-555-0142" })
    .onConflictDoUpdate({
      target: schema.businessProfiles.workspaceId,
      set: { signature: "Davi\n978-555-0142" },
    });
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card).toContainText("Asked for the address and panel age.");
  await expect(page.getByText("No signature.")).toHaveCount(0);
});

test("hitting the send endpoint directly before setup gets a 403", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");

  const sameOrigin = await page.request.post(`/api/drafts/${draft.id}/send`, {
    headers: { origin: baseURL! },
    data: {},
  });
  expect(sameOrigin.status()).toBe(403);
  const crossSite = await page.request.post(`/api/drafts/${draft.id}/send`, {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(crossSite.status()).toBe(403);

  const [after] = await testDb.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
  expect(after!.status).toBe("pending");
});

test("after sending: the squared-away moment", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb.update(schema.drafts).set({ status: "sent" }).where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto(`/queue?sent=${draft.id}`);
  await expect(page.getByText("reply sent,")).toBeVisible();
  await expect(page.getByText("squared away.")).toBeVisible();
  // A quote: we say when we'll nudge if it goes quiet.
  await expect(
    page.getByText(/A nudge for Priya will be ready \w+day morning if there's no reply\./),
  ).toBeVisible();
});

test("a link from the morning summary lands on its card (plan #31)", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { quote } = await seedQueue(owner.mailboxId!);
  // Enough waiting above it that the oldest card starts well below the fold on a phone.
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId: owner.mailboxId!,
        gmailThreadId: `anchor-${i}-${owner.mailboxId}`,
        inInbox: true,
        category: "customer_question",
        needsOwner: true,
        needsOwnerReason: `Question number ${i}.`,
        lastMessageAt: new Date(Date.now() - (i + 1) * 3600_000),
      })
      .returning();
    ids.push(t!.id);
  }
  const oldest = ids.at(-1)!;
  await signInAs(context, owner);
  // No smooth scrolling (ScrollToThread then jumps), so where a card lands is final once settled.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto(`/queue#t-${oldest}`);
  const card = page.locator(`article#t-${oldest}`);
  await expect(card).toContainText("Question number 7.");
  await settled(page);
  await expect(card).toBeInViewport({ ratio: 0.5 });
  // The page didn't simply open at the top.
  await expect(page.getByRole("heading", { name: "Needs you" })).not.toBeInViewport();
  // Its top (the customer's name) sits at the top of the screen, not centred (finding M8-6).
  const viewport = page.viewportSize()!;
  const top = async (loc: typeof card) => (await loc.boundingBox())!.y;
  expect(await top(card)).toBeGreaterThanOrEqual(0);
  expect(await top(card)).toBeLessThan(viewport.height / 4);
  // On a phone, the fixed tab bar at the bottom doesn't cover it.
  const tabBar = page.locator('nav[aria-label="Main"].fixed');
  const phone = await tabBar.isVisible();
  const barY = phone ? (await tabBar.boundingBox())!.y : viewport.height;
  if (phone) {
    const box = (await card.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(barY);
  }

  // Draft cards carry the same anchor, and a hash change on the page moves to it. From the top,
  // with the hash set quietly and the event sent by hand, so the browser's own jump to the
  // fragment can't stand in for ScrollToThread.
  const draftCard = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(draftCard).toHaveAttribute("id", `t-${quote.t.id}`);
  await page.evaluate((id) => {
    window.scrollTo(0, 0);
    const oldURL = window.location.href;
    history.replaceState(history.state, "", `#t-${id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: location.href }));
  }, quote.t.id);
  await settled(page);
  // Centring a tall draft card once put the name above the screen and the bottom under the tab
  // bar. Its top edge must be on screen, at or below 0, and above the tab bar — after a hash
  // change and after a real load (what a notification opens).
  const expectTopOnScreen = async () => {
    const y = await top(draftCard);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(Math.min(barY, viewport.height / 4));
  };
  await expectTopOnScreen();
  await page.goto(`/queue?t=${quote.t.id}#t-${quote.t.id}`);
  await expect(draftCard).toBeVisible();
  await settled(page);
  await expect(page.getByRole("heading", { name: "Needs you" })).not.toBeInViewport();
  await expectTopOnScreen();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  // A link to something no longer on the queue says so, rather than leaving them at the top.
  await page.goto(`/queue#t-00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText("That email isn't on your queue right now.")).toBeVisible();
});

test("a refresh that keeps the link doesn't pull the owner back to the card", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { quote } = await seedQueue(owner.mailboxId!);
  for (let i = 0; i < 8; i++)
    await testDb.insert(schema.threads).values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `above-${i}-${owner.mailboxId}`,
      inInbox: true,
      category: "customer_question",
      needsOwner: true,
      needsOwnerReason: `Question number ${i}.`,
      lastMessageAt: new Date(Date.now() - (i + 1) * 3600_000),
    });
  await signInAs(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });

  // A summary link lands on the card…
  await page.goto(`/queue#t-${quote.t.id}`);
  const needsYou = page.getByRole("heading", { name: "Needs you" });
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toBeVisible();
  await settled(page);
  await expect(needsYou).not.toBeInViewport();

  // …then the owner scrolls up and turns on Sunlight. That action re-renders the page in place
  // (no redirect, `#t-…` still in the URL), which remounts ScrollToThread.
  await page.evaluate(() => window.scrollTo(0, 0));
  const sunlight = page.getByRole("button", { name: "Sunlight" });
  await expect(sunlight).toHaveAttribute("aria-pressed", "false");
  await sunlight.click();
  await expect(sunlight).toHaveAttribute("aria-pressed", "true");
  await settled(page);
  expect(page.url()).toContain(`#t-${quote.t.id}`);
  await expect(needsYou).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50);
});

test("a 'not on your queue' notice goes away after the next queue action", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  const gone = "/queue#t-00000000-0000-4000-8000-000000000000";
  const notice = page.getByText("That email isn't on your queue right now.");

  // An unrelated queue action redirects to /queue?done=…, which keeps client state.
  await page.goto(gone);
  await expect(notice).toBeVisible();
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await card.getByRole("button", { name: "Remind me later" }).click();
  await card.getByRole("button", { name: "After this job (3 hours)" }).click();
  await expect(page.getByText("Snoozed.")).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Even when the action lands on the very same search params as the link did (so a key
  // built from the URL alone wouldn't change), the notice still goes.
  await page.goto(`/queue?done=snoozed${gone.slice("/queue".length)}`);
  await expect(notice).toBeVisible();
  const dana = page.locator("article", { hasText: "Customer says the leak came back." });
  await dana.getByRole("button", { name: "Remind me later" }).click();
  await dana.getByRole("button", { name: "After this job (3 hours)" }).click();
  await expect(dana).toHaveCount(0);
  // Check 9 P5: the last card's own id rides along (`&t=`), so the URL changes.
  await expect(page).toHaveURL(/\/queue\?done=snoozed&t=[0-9a-f-]{36}$/);
  await expect(page.getByText("Snoozed.")).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("a notification tap from an open queue reloads it and lands on the new card (plan #34)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  for (let i = 0; i < 8; i++)
    await testDb.insert(schema.threads).values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `older-${i}-${owner.mailboxId}`,
      inInbox: true,
      category: "customer_question",
      needsOwner: true,
      needsOwnerReason: `Older question ${i}.`,
      lastMessageAt: new Date(Date.now() - (i + 1) * 3600_000),
    });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

  // A quote request arrives (oldest, so its card sits low on the page) while the queue is open.
  const [lead] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `lead-${owner.mailboxId}`,
      inInbox: true,
      category: "quote_request",
      needsOwner: true,
      needsOwnerReason: "Big kitchen job, check before quoting.",
      lastMessageAt: new Date(Date.now() - 20 * 3600_000),
    })
    .returning();
  // What the service worker navigates to: the query makes it a real load, not a hash jump.
  await page.goto(`/queue?t=${lead!.id}#t-${lead!.id}`);
  const card = page.locator(`article#t-${lead!.id}`);
  await expect(card).toContainText("Big kitchen job");
  await expect(card).toBeInViewport({ ratio: 0.5 });
  await expect(page.getByText("That email isn't on your queue right now.")).toHaveCount(0);
});

test("empty queue says so plainly", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByText("Nothing waiting on you.")).toBeVisible();
});

test("undo send: the window shows a countdown, and Undo puts the reply back", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ sendAfter: new Date(Date.now() + 120_000) })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto(`/queue?sent=${draft.id}`);
  await expect(page.getByText("reply on its way,")).toBeVisible();
  await expect(page.getByText(/Sending in \d+ seconds/)).toBeVisible();
  // While it's going, it's not in the queue to tap again.
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Stopped. Nothing was sent")).toBeVisible();
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toBeVisible();
});

test("remind me later: the conversation leaves the queue until then", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await card.getByRole("button", { name: "Remind me later" }).click();
  await card.getByRole("button", { name: "After this job (3 hours)" }).click();
  await expect(page.getByText("Snoozed.")).toBeVisible();
  await expect(page.getByRole("article", { name: "Priya · draft reply" })).toHaveCount(0);
});

test("review all ready: lists who and how it starts, then asks once before sending", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  // The seeded complaint needs the owner, so it's never in the batch.
  const { draft } = await seedQueue(owner.mailboxId!);
  // Make the seeded quote draft Ready, and add a second Ready one.
  await testDb
    .update(schema.drafts)
    .set({ flags: [], confidence: 92 })
    .where(eq(schema.drafts.id, draft.id));
  const [t2] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId!,
      gmailThreadId: `s-${owner.mailboxId}`,
      inInbox: true,
      category: "scheduling",
      lastMessageAt: new Date(),
    })
    .returning();
  await testDb.insert(schema.messages).values({
    threadId: t2!.id,
    mailboxId: owner.mailboxId!,
    gmailMessageId: `m-s-${owner.mailboxId}`,
    direction: "in",
    fromName: "Omar",
    fromAddress: "omar@x.com",
    sentAt: new Date(),
  });
  await testDb.insert(schema.drafts).values({
    threadId: t2!.id,
    mailboxId: owner.mailboxId!,
    gmailDraftId: "fake-draft-2",
    toAddress: "omar@x.com",
    subject: "Re: Time",
    // Check 41 P2: no day named (a reply that confirms a visit day goes one at a time).
    body: "Hi Omar,\nGot it — thanks for the update.\nSam",
    originalBody: "same",
    reason: "Confirms the time.",
    confidence: 95,
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  await page.getByRole("link", { name: "Review all 2 ready" }).click();
  await expect(page).toHaveURL(/\/queue\/review$/);
  const list = page.getByRole("list", { name: "Replies to send" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("To Omar");
  await expect(list).toContainText("Got it — thanks for the update.");
  await expect(list).toContainText("What's the address, and how old is the current panel?");

  // Untick Scheduling → only the quote is left.
  await page.getByRole("link", { name: "Scheduling" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("link", { name: "Scheduling" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await page.getByRole("button", { name: "Send 2 replies" }).click();
  await expect(page.getByRole("button", { name: "Yes, send 2 replies" })).toBeVisible();
  await page.getByRole("button", { name: "Not yet" }).click();
  await expect(page.getByRole("button", { name: "Send 2 replies" })).toBeVisible();
});

test("price memory: past prices for similar jobs, and a tap fills only the price gap (plan #15)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "setup_paid",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  const { quote, draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.threads)
    .set({ extracted: { service_requested: "panel upgrade" } })
    .where(eq(schema.threads.id, quote.t.id));
  await testDb
    .update(schema.drafts)
    .set({
      body: "Hey Priya,\n\nThe panel upgrade is {{price}} including the permit. I can come {{date}} at {{time}}.\n\nThanks, Davi",
      flags: [],
    })
    .where(eq(schema.drafts.id, draft.id));
  // Two earlier panel quotes (not in the inbox any more), remembered from the owner's replies.
  const year = new Date().getUTCFullYear();
  for (const [service, cents, month] of [
    ["200 amp panel upgrade", 180000, 2],
    ["Panel upgrade", 210000, 5],
  ] as const) {
    const [t] = await testDb
      .insert(schema.threads)
      .values({
        mailboxId: owner.mailboxId!,
        gmailThreadId: `old-${month}-${owner.mailboxId}`,
        category: "quote_request",
        inInbox: false,
      })
      .returning();
    await testDb.insert(schema.priceHistory).values({
      workspaceId: owner.workspaceId,
      threadId: t!.id,
      service,
      amountCents: cents,
      quotedAt: new Date(Date.UTC(year, month, 15, 16)),
    });
  }
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  const memory = card.getByRole("region", { name: "Last 2 similar quotes:" });
  await expect(memory).toBeVisible();
  await expect(memory).toContainText("Only you see these.");
  await expect(card.getByRole("button", { name: "Fill in price" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Fill in 3 gaps to send" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  // Amounts are visible text only — never in an aria-label (A9).
  await expect(page.locator('[aria-label*="$"]')).toHaveCount(0);

  // The same figures are offered inside the price gap's own form.
  await card.getByRole("button", { name: "Fill in price" }).click();
  await expect(card.getByText("Or use one of your past prices:")).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();

  // A past price tapped while another gap's form is open: the gaps shift, so that form closes
  // rather than put the owner's answer into a different gap.
  await card.getByRole("button", { name: "Fill in date" }).click();
  await card.getByLabel("What should “date” say?").fill("Thursday");
  await memory.getByRole("button", { name: "Use $1,800 (Mar)" }).click();
  await expect(card.getByRole("button", { name: "Fill in price" })).toHaveCount(0);
  await expect(card.getByLabel("What should “time” say?")).toHaveCount(0);
  await expect(card.getByLabel("What should “date” say?")).toHaveCount(0);
  await expect(card).toContainText("The panel upgrade is $1,800 including the permit.");
  await expect(memory).toContainText("No price gap left to fill.");
  await expect(memory.getByRole("button", { name: "Use $2,100 (Jun)" })).toBeDisabled();

  // The other gaps are still there, each filling its own place.
  await card.getByRole("button", { name: "Fill in date" }).click();
  await card.getByLabel("What should “date” say?").fill("Thursday");
  await card.getByRole("button", { name: "Fill in", exact: true }).click();
  await card.getByRole("button", { name: "Fill in time" }).click();
  await card.getByLabel("What should “time” say?").fill("8am");
  await card.getByRole("button", { name: "Fill in", exact: true }).click();
  await expect(card).toContainText("I can come Thursday at 8am.");
  await expect(card.getByRole("button", { name: "Send reply" })).toBeEnabled();

  // The Inbox row shows the same figures, as text.
  await page.goto("/inbox?c=quote_request");
  await page.getByText("Panel upgrade quote.").click();
  await expect(page.getByText("Last 2 similar quotes: $2,100 (Jun), $1,800 (Mar)")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("a [name]-style blank is a gap: a chip, never Ready, Send reply only once filled (Check 23 P7)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "setup_paid",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  const { draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({
      body: "Hi [name],\n\nHappy to take a look. What's the address?\n\nThanks, Davi",
      flags: ["Has a blank (“[name]”) to fill in."],
      confidence: 60,
    })
    .where(eq(schema.drafts.id, draft.id));
  await signInAs(context, owner);

  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(card.getByRole("button", { name: "Fill in their name" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Fill in 1 gap to send" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card).not.toContainText("Ready");

  await card.getByRole("button", { name: "Fill in their name" }).click();
  await card.getByLabel("What should “their name” say?").fill("Priya");
  await card.getByRole("button", { name: "Fill in", exact: true }).click();
  await expect(card).toContainText("Hi Priya,");
  await expect(card.getByRole("button", { name: "Send reply" })).toBeEnabled();
});

test("a typical draft's Send reply is on the first screen of its card (outside review)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { quote, draft } = await seedQueue(owner.mailboxId!);
  await setWorkspace(owner.workspaceId, { status: "active", setupPaidVia: "stripe" });
  await signInAs(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/queue?t=${quote.t.id}#t-${quote.t.id}`);
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(card).toBeVisible();
  await settled(page);
  const send = card.getByRole("button", { name: "Send reply" });
  await expect(send).toBeInViewport({ ratio: 1 });
  // Check 9 P1: Send reply posts the fingerprint of the text on the card, so a draft that
  // changes after the page rendered is refused instead of sent.
  const seen = card.locator('form:has(button:text("Send reply")) input[name="seen"]');
  await expect(seen).toHaveValue(
    createHash("sha256")
      .update(draft.body ?? "")
      .digest("hex"),
  );
  const tabBar = page.locator('nav[aria-label="Main"].fixed');
  if (await tabBar.isVisible()) {
    const box = (await send.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await tabBar.boundingBox())!.y);
  }
  // The tweaks are one tap away, and nothing is sent by opening them.
  await card.getByRole("button", { name: "Change it" }).click();
  await expect(card.getByRole("form", { name: "Quick changes" })).toBeVisible();
  await expect(card.getByLabel("Tell it what to change")).toBeVisible();
});

test("a first reply to a new lead says so and offers other ways to reply (replies package)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const { quote, draft } = await seedQueue(owner.mailboxId!);
  await testDb
    .update(schema.drafts)
    .set({ opening: "details", flags: [] })
    .where(eq(schema.drafts.id, draft.id));
  await setWorkspace(owner.workspaceId, { status: "active", setupPaidVia: "stripe" });
  await signInAs(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/queue?t=${quote.t.id}#t-${quote.t.id}`);
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  await expect(card).toContainText("First reply: asks 1 question · they described the job");
  const others = card.getByRole("form", { name: "Other ways to reply" });
  for (const name of ["Ask a few questions", "Offer to come take a look", "Short and friendly"]) {
    const chip = others.getByRole("button", { name });
    await expect(chip).toBeVisible();
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // Send reply still sits on the card's first screen, above the chips and the tab bar.
  await settled(page);
  const send = card.getByRole("button", { name: "Send reply" });
  await expect(send).toBeInViewport({ ratio: 1 });
  expect((await send.boundingBox())!.y).toBeLessThan(
    (await others.getByRole("button", { name: "Ask a few questions" }).boundingBox())!.y,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  // A read-only account sees the draft, never the chips.
  await setWorkspace(owner.workspaceId, { status: "evaluation_expired" });
  await page.reload();
  await expect(card).toContainText("First reply: asks 1 question");
  await expect(card.getByRole("form", { name: "Other ways to reply" })).toHaveCount(0);
});

test("Edit puts the cursor at the end, keeps Send reply apart, and hides the tab bar while typing (Check 8 P7, P9)", async ({
  page,
  context,
  isMobile,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
  });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Priya · draft reply" });
  // Check 8 P9: the To line and the card facts are 16px.
  const toLine = card.locator("p", { hasText: "To:" }).first();
  expect(
    await toLine.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(16);

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const box = card.getByLabel("Your reply");
  await expect(box).toBeFocused();
  const sel = await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.value.length]);
  expect(sel[0]).toBe(sel[1]);
  expect(sel[1]).toBeGreaterThan(0);
  const boxBottom = (await box.boundingBox())!;
  const send = (await card.getByRole("button", { name: "Send reply" }).boundingBox())!;
  expect(send.y - (boxBottom.y + boxBottom.height)).toBeGreaterThanOrEqual(24);

  if (isMobile) {
    const tabBar = page.locator('nav[aria-label="Main"].fixed');
    await expect(tabBar).toBeHidden();
    await box.blur();
    await expect(tabBar).toBeVisible();
  }
});
