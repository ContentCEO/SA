import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { formatGrowthBlock } from "../../src/server/growth-note";
import { seedAdmin, seedOwner, signInAs, testDb } from "./support";

/**
 * Squared Away Growth clients (Davi, 2026-10-16): the sign-in choice, the dashboard (only what
 * Davi entered), the admin forms and Remove. Runs at 375px and on desktop (both projects).
 */

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const unique = (p: string) =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

async function growthClient(
  workspaceId: string,
  over: Partial<typeof schema.growthClients.$inferInsert> = {},
) {
  const [c] = await testDb
    .insert(schema.growthClients)
    .values({ workspaceId, startedOn: "2026-09-01", services: ["google_ads", "reviews"], ...over })
    .returning();
  return c!;
}

test("/start: a Growth client chooses; anyone else goes on to the queue", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await growthClient(owner.workspaceId);
  await signInAs(context, owner);
  await page.goto("/start");
  const nav = page.getByRole("navigation", { name: "Choose" });
  const inbox = nav.getByRole("link", { name: /My inbox · Squared Away/ });
  const growth = nav.getByRole("link", { name: /My Growth dashboard/ });
  await expect(inbox).toHaveAttribute("href", "/queue");
  await expect(growth).toHaveAttribute("href", "/my-growth");
  for (const l of [inbox, growth])
    expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBe(true);
  await growth.click();
  await expect(page).toHaveURL(/\/my-growth$/);

  // The homepage and /signin send a signed-in Growth client to the choice too.
  await page.goto("/");
  await expect(page).toHaveURL(/\/start$/);

  // Never connected Gmail: the inbox shows the connect step (no trial starts by signing in).
  await page.goto("/start");
  await page.getByRole("link", { name: /My inbox/ }).click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByRole("link", { name: "Connect Gmail" })).toBeVisible();

  // More has the Growth link back to the dashboard.
  await page.goto("/more");
  await expect(
    page.getByRole("navigation", { name: "More" }).getByRole("link", { name: /^Growth/ }),
  ).toHaveAttribute("href", "/my-growth");
});

test("/start sends an owner who isn't a Growth client straight to the queue", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/start");
  await expect(page).toHaveURL(/\/queue$/);
  expect((await page.goto("/my-growth"))?.status()).toBe(404);
  // More shows the same static Growth line as everyone, and no dashboard link.
  await page.goto("/more");
  await expect(page.getByRole("complementary", { name: "Grow your business" })).toContainText(
    "Want more work coming in? Squared Away Growth is a separate service. Nothing from your email is used for it.",
  );
  await expect(
    page.getByRole("complementary", { name: "Grow your business" }).getByRole("link"),
  ).toHaveAttribute("href", "/growth");
  await expect(page.getByRole("link", { name: /^Growth/ })).toHaveCount(0);
});

test("the dashboard: Davi's numbers with their source, updates, services, pledge, call", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  const c = await growthClient(owner.workspaceId, { startedOn: "2026-01-05" });
  const other = await seedOwner();
  const oc = await growthClient(other.workspaceId);
  const thisMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
  await testDb.insert(schema.growthMonthly).values([
    { growthClientId: c.id, month: "2026-02", newLeads: 4, moneyWonCents: 300000 },
    { growthClientId: c.id, month: thisMonth, newLeads: 6, reviewsGained: 2 },
    { growthClientId: oc.id, month: thisMonth, newLeads: 999 },
  ]);
  await testDb.insert(schema.growthUpdates).values([
    { growthClientId: c.id, title: "Ads are live", body: "Two ads.\nBudget as agreed." },
    { growthClientId: oc.id, title: "Someone else's update", body: "x" },
  ]);
  await signInAs(context, owner);
  const res = await page.goto("/my-growth");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("in plain numbers.");

  const since = page.getByRole("region", { name: "Since you started" });
  await expect(since).toContainText("Jan 5, 2026");
  await expect(since).toContainText(
    "Money from jobs you won since Growth started (as you told Davi)",
  );
  await expect(since).toContainText("$3,000");
  await expect(since).toContainText("From your monthly check-ins with Davi (2 months).");
  const month = page.getByRole("region", { name: "This month" });
  await expect(month).toContainText("From your monthly check-in with Davi.");
  await expect(month).toContainText("Reviews gained");
  await expect(page.getByRole("main")).not.toContainText("999");
  await expect(page.getByRole("main")).not.toContainText("Someone else's update");

  const updates = page.getByRole("region", { name: "Updates from Davi" });
  await expect(updates.getByRole("heading", { name: "Ads are live" })).toBeVisible();
  const services = page.getByRole("region", { name: "What we do for you" });
  await expect(services).toContainText("Google ads");
  await expect(services).toContainText("We never take a percentage of your jobs or your business.");
  const talk = page.getByRole("region", { name: "Talk to Davi" });
  await expect(talk.getByRole("link", { name: "Call 978-201-9763" })).toHaveAttribute(
    "href",
    "tel:+19782019763",
  );
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My inbox" }),
  ).toHaveAttribute("href", "/queue");
  expect(await noOverflow(page)).toBe(true);
  expect(await page.getByRole("main").innerText()).not.toMatch(/\binbox count|counted from/i);
});

test("the dashboard before the first check-in, and while paused", async ({ page, context }) => {
  const owner = await seedOwner();
  await growthClient(owner.workspaceId, { status: "paused" });
  await signInAs(context, owner);
  await page.goto("/my-growth");
  await expect(page.getByRole("status")).toContainText("Growth work is paused for now.");
  await expect(page.getByRole("region", { name: "Since you started" })).toContainText(
    "Davi adds these after your first monthly check-in.",
  );
  await expect(page.getByRole("region", { name: "Updates from Davi" })).toContainText(
    "No updates yet.",
  );
  expect(await noOverflow(page)).toBe(true);
});

test("the pledge is on /growth and in the homepage's Growth half", async ({ page }) => {
  for (const path of ["/growth", "/"]) {
    await page.goto(path);
    const pledge = page.getByRole("region", { name: "You own everything" });
    await expect(pledge).toContainText("you own everything.");
    await expect(pledge).toContainText("your website and its domain");
    await expect(pledge).toContainText("We never take a percentage of your jobs or your business.");
  }
});

test("admin: start Growth, post an update, enter a month, pause; the client sees it", async ({
  page,
  context,
  browser,
}) => {
  const owner = await seedOwner();
  await testDb
    .update(schema.workspaces)
    .set({ businessName: `Portal Plumbing ${owner.email}` })
    .where(eq(schema.workspaces.id, owner.workspaceId));
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#growth");
  const section = page.locator("#growth");

  const start = section.locator("details", {
    has: page.locator("summary", { hasText: /^Start Growth for this account$/ }),
  });
  await start.locator("summary").click();
  await start
    .getByLabel("Account")
    .selectOption({ label: `Portal Plumbing ${owner.email} (${owner.email})` });
  await start.getByLabel("Reviews").check();
  await start.getByLabel("Start date").fill("2026-01-05");
  await start.getByRole("button", { name: "Start Growth" }).click();
  await expect(page).toHaveURL(/done=growth_started#growth$/);
  await expect(page.locator("#growth").getByRole("status")).toContainText("Growth started.");

  const card = page.getByRole("article", { name: `Growth client: Portal Plumbing ${owner.email}` });
  await card.getByText("Post an update", { exact: true }).click();
  await card.getByLabel("Title").fill("Reviews link is ready");
  await card.getByLabel("What to tell them").fill("Send it to every customer.");
  await card.getByRole("button", { name: "Post update" }).click();
  // E2E has no email set up: posted, and it says nobody was emailed.
  await expect(page).toHaveURL(/done=growth_posted_no_email#growth$/);
  await expect(card).toContainText("Not emailed yet");

  await card.getByText("Add numbers for a month", { exact: true }).click();
  await card.getByLabel("Month").selectOption({ index: 0 });
  await card.getByLabel("New leads").fill("12");
  await card.getByLabel("Money from jobs won ($)").fill("4,500");
  await card.getByRole("button", { name: "Save numbers" }).click();
  await expect(page).toHaveURL(/done=growth_month_saved#growth$/);
  await expect(card).toContainText("12 new leads · $4,500 money from jobs won");

  await card.getByText("Pause Growth", { exact: true }).click();
  await card.getByRole("button", { name: "Yes, pause Growth" }).click();
  await expect(page).toHaveURL(/done=growth_pause#growth$/);
  await expect(card).toContainText("Paused");

  // The client sees exactly that.
  const theirs = await browser.newContext({ viewport: page.viewportSize()! });
  await signInAs(theirs, owner);
  const p2 = await theirs.newPage();
  await p2.goto("/my-growth");
  await expect(p2.getByRole("heading", { name: "Reviews link is ready" })).toBeVisible();
  await expect(p2.getByRole("region", { name: "This month" })).toContainText("$4,500");
  await expect(p2.getByRole("status")).toContainText("paused");
  await theirs.close();
});

test("admin: Invite to Growth and Remove on waitlist Growth requests", async ({
  page,
  context,
}) => {
  const only = unique("growth-only");
  const mixed = unique("growth-mixed");
  const block = formatGrowthBlock({
    at: "2026-10-12 09:12",
    services: ["Google ads", "Reviews"],
    phone: "617-555-0142",
  });
  await testDb.insert(schema.waitlist).values([
    {
      email: only,
      name: "Sam Okafor",
      teamSize: "growth-only",
      phone: "617-555-0142",
      note: block,
    },
    {
      email: mixed,
      name: "Rosa Lima",
      teamSize: "2–5",
      trade: "plumbing",
      note: `Two vans\n\n${block}`,
    },
  ]);
  await signInAs(context, await seedAdmin());
  await page.goto("/admin#waitlist");

  const a = page.getByRole("listitem", { name: `Waitlist: ${only}` });
  await a.getByText("Invite to Growth", { exact: true }).click();
  // The request's services come pre-ticked.
  await expect(a.getByLabel("Google ads")).toBeChecked();
  await expect(a.getByLabel("Website")).not.toBeChecked();
  await a.getByRole("button", { name: "Invite to Growth" }).click();
  await expect(page).toHaveURL(/done=wl_growth_invited#waitlist$/);
  const [inv] = await testDb.select().from(schema.invites).where(eq(schema.invites.email, only));
  expect(inv!.growthServices).toEqual(["google_ads", "reviews"]);
  await expect(page.getByRole("listitem", { name: `Waitlist: ${only}` })).toContainText(
    "Invited to Growth",
  );

  // Remove on a mixed row keeps the app sign-up.
  const b = page.getByRole("listitem", { name: `Waitlist: ${mixed}` });
  await b.getByText("Remove Growth request", { exact: true }).click();
  await expect(b).toContainText("Their app waitlist sign-up stays as it is.");
  await b.getByRole("button", { name: "Yes, remove the Growth request" }).click();
  await expect(page).toHaveURL(/done=wl_growth_request_block_removed#waitlist$/);
  const [left] = await testDb
    .select()
    .from(schema.waitlist)
    .where(eq(schema.waitlist.email, mixed));
  expect(left!.note).toBe("Two vans");

  // Remove on a Growth-only row deletes it.
  const c = page.getByRole("listitem", { name: `Waitlist: ${only}` });
  await c.getByText("Remove Growth request", { exact: true }).click();
  await c.getByRole("button", { name: "Yes, delete this request" }).click();
  await expect(page).toHaveURL(/done=wl_growth_request_deleted#waitlist$/);
  expect(
    await testDb.select().from(schema.waitlist).where(eq(schema.waitlist.email, only)),
  ).toEqual([]);
});
