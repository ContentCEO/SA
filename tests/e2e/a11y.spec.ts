import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { seedAdmin, seedOwner, seedQueue, setWorkspace, signInAs } from "./support";

/**
 * Check 32 P8: axe (WCAG 2.0 / 2.1 / 2.2, A and AA) on every screen the e2e can reach, as the
 * owner, a trial owner and the admin, at phone and desktop size. Fails on any serious or
 * critical violation (named with the page and the first few elements).
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function serious(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${path} ${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")}`,
    );
}

async function check(page: Page, paths: string[]) {
  const found: string[] = [];
  for (const path of paths) found.push(...(await serious(page, path)));
  expect(found).toEqual([]);
}

test.describe("axe", () => {
  test.describe.configure({ timeout: 180_000 });

  test("public pages", async ({ page }) => {
    await check(page, [
      "/",
      "/growth",
      "/signin",
      "/privacy",
      "/terms",
      "/not-invited",
      "/goodbye",
    ]);
  });

  test("the owner's screens", async ({ page, context }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await setWorkspace(owner.workspaceId, { status: "active", plan: "crew" });
    await seedQueue(owner.mailboxId!);
    await signInAs(context, owner);
    await check(page, [
      "/queue",
      "/queue/review",
      "/queue/review?cat=quote_request",
      "/inbox",
      "/quotes",
      "/money",
      "/more",
      "/customers",
      "/activity",
      "/billing",
    ]);
  });

  test("the owner's settings", async ({ page, context }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await signInAs(context, owner);
    await check(page, [
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
    ]);
  });

  test("a trial owner, before and after connecting", async ({ page, context }) => {
    const fresh = await seedOwner();
    await signInAs(context, fresh);
    await check(page, ["/connect", "/welcome/profile"]);
    const trial = await seedOwner({ mailbox: true, backfilled: true });
    await setWorkspace(trial.workspaceId, {
      status: "evaluating",
      evaluationEndsAt: new Date(Date.now() + 2 * 86_400_000),
    });
    await seedQueue(trial.mailboxId!);
    await context.clearCookies();
    await signInAs(context, trial);
    await check(page, ["/queue", "/welcome/learning", "/billing"]);
  });

  test("the admin's screens", async ({ page, context }) => {
    await signInAs(context, await seedAdmin());
    await check(page, ["/admin", "/admin/costs", "/admin/growth"]);
  });
});
