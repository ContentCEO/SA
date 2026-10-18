import { expect, test } from "@playwright/test";
import { seedOwner, seedQueue, signInAs } from "./support";

/** Check 32 P6: every signed-in screen has its own title, ending "· Squared Away". */
const SCREENS = [
  "/queue",
  "/queue/review",
  "/inbox",
  "/quotes",
  "/money",
  "/more",
  "/customers",
  "/activity",
  "/settings",
  "/settings/account",
  "/settings/autopilot",
  "/settings/away",
  "/settings/business",
  "/settings/follow-ups",
  "/settings/gmail",
  "/settings/morning-email",
  "/settings/phone",
  "/settings/sender-rules",
  "/settings/writing",
  "/settings/profile",
  "/settings/voice",
  "/billing",
  "/connect",
  "/welcome/profile",
  "/welcome/learning",
];

test("every signed-in screen has its own title", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "titles don't depend on the screen size");
  test.setTimeout(120_000);
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  const seen = new Map<string, string>();
  for (const path of SCREENS) {
    await page.goto(path);
    const landed = new URL(page.url()).pathname;
    if (landed !== path) continue; // a screen that sends this owner elsewhere
    const title = await page.title();
    expect(title, path).toMatch(/^.+ · Squared Away$/);
    expect(seen.get(title), `${path} has the same title as ${seen.get(title)}`).toBeUndefined();
    seen.set(title, path);
  }
  expect(seen.size).toBeGreaterThan(20);
  // Two things wait (a reply and a needs-you email): a number only.
  expect([...seen.entries()].find(([, p]) => p === "/queue")?.[0]).toBe("Queue (2) · Squared Away");
});

test("moving from Queue to Inbox changes the title", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page).toHaveTitle("Queue · Squared Away");
  await page
    .getByRole("navigation", { name: "Main" })
    .filter({ visible: true })
    .getByRole("link", { name: "Inbox" })
    .click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page).toHaveTitle("Inbox · Squared Away");
});
