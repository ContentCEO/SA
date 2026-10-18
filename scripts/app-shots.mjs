/*
 * Check 46 P4: the phone screenshots in the app manifest (public/app-shots/), for Chrome's
 * richer install sheet. Made from the invented e2e seed data only (tests/e2e/support.ts:
 * seedOwner + seedQueue) — never a real mailbox.
 *
 * Needs the local e2e app running (the same servers `pnpm test:e2e` starts, with a local
 * DATABASE_URL in .env.local), then:
 *
 *   pnpm exec tsx scripts/app-shots.mjs [path to a Chromium]
 *
 * 1080x1920 PNGs: a 360x640 phone at 3x (web.dev's Richer Install UI sizes).
 */
import { config } from "dotenv";
import { chromium } from "@playwright/test";

config({ path: [".env.local", ".env"], quiet: true });

const { seedOwner, seedQueue, setWorkspace, signInAs, testDb } =
  await import("../tests/e2e/support.ts");

// The local app: APP_URL from .env.local (e2e requires it to be the origin Playwright drives).
const baseURL = process.env.APP_URL ?? "http://localhost:3100";
const out = "public/app-shots";

const schema = await import("../src/db/schema.ts");
const { eq } = await import("drizzle-orm");

const owner = await seedOwner({ mailbox: true, backfilled: true });
await setWorkspace(owner.workspaceId, { status: "active", setupPaidVia: "stripe" });
const seeded = await seedQueue(owner.mailboxId);
// Invented names only. The seed's sign-off becomes a made-up owner's, and two more invented
// quote requests with replies ready make the queue look like a normal morning.
await testDb
  .update(schema.drafts)
  .set({ body: seeded.draft.body.replace(/Thanks, \w+$/, "Thanks, Sam") })
  .where(eq(schema.drafts.id, seeded.draft.id));
const more = [
  [
    "Marcus",
    "Water heater swap quote.",
    "Hi Marcus,\n\nHappy to take a look. Is the current heater gas or electric, and how many gallons?\n\nThanks, Sam",
  ],
  [
    "Lena",
    "Kitchen faucet leak.",
    "Hi Lena,\n\nSorry about the drip. I can stop by Thursday afternoon if that works for you.\n\nThanks, Sam",
  ],
];
for (const [name, summary, body] of more) {
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: owner.mailboxId,
      gmailThreadId: `shot-${name}-${owner.mailboxId}`,
      inInbox: true,
      category: "quote_request",
      summary,
      lastMessageAt: new Date(),
    })
    .returning();
  const [m] = await testDb
    .insert(schema.messages)
    .values({
      threadId: t.id,
      mailboxId: owner.mailboxId,
      gmailMessageId: `shot-m-${name}-${owner.mailboxId}`,
      direction: "in",
      fromName: name,
      fromAddress: `${name.toLowerCase()}@example.com`,
      sentAt: new Date(),
    })
    .returning();
  await testDb.insert(schema.drafts).values({
    threadId: t.id,
    mailboxId: owner.mailboxId,
    replyToMessageId: m.id,
    gmailDraftId: `shot-draft-${name}`,
    toAddress: `${name.toLowerCase()}@example.com`,
    subject: `Re: ${summary}`,
    body,
    originalBody: body,
    reason: summary,
    confidence: 90,
  });
}
// The getting-started list is done (profile filled in, list hidden), so the cards show.
await testDb
  .insert(schema.businessProfiles)
  .values({
    workspaceId: owner.workspaceId,
    completedAt: new Date(),
    onboardingDismissedAt: new Date(),
  })
  .onConflictDoNothing();

// An optional Chromium to use (a sandbox's preinstalled one): the first argument.
const executablePath = process.argv[2];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    timezoneId: "America/New_York",
  });
  await signInAs(context, owner);
  // The swipe tip was seen on this phone already.
  await context.addInitScript(() => localStorage.setItem("sa_swipe_tip_seen", "1"));
  const page = await context.newPage();

  await page.goto("/queue");
  const send = page.getByRole("button", { name: "Send reply" }).first();
  await send.waitFor();
  // The replies waiting for an okay: scroll to the first one (a little of what's above shows).
  const showFrom = (el) => {
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -24);
  };
  await page.getByText("Marcus", { exact: true }).first().evaluate(showFrom);
  await page.screenshot({ path: `${out}/queue.png` });

  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const box = page.getByRole("textbox").first();
  await box.waitFor();
  await box.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${out}/draft.png` });

  await page.goto("/quotes");
  await page.waitForLoadState("networkidle");
  await page.getByText("Marcus", { exact: true }).first().evaluate(showFrom);
  await page.screenshot({ path: `${out}/quotes.png` });
} finally {
  await browser.close();
  await testDb.$client.end();
}
