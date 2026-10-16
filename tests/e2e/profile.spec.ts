import { expect, test } from "@playwright/test";
import * as schema from "../../src/db/schema";
import { seedOwner, signInAs, testDb } from "./support";

test("onboarding: business profile, then the learning screen", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);

  await page.goto("/welcome/profile");
  await expect(page.getByText("Step 2 of 3")).toBeVisible();

  // Missing required fields → plain-language errors, nothing lost.
  await page.getByLabel("What work do you take on?").fill("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "need fixing" })).toBeVisible();
  // The first field needing attention gets focus, so a phone user isn't left staring at the bottom.
  await expect(page.getByLabel("What's the business called?")).toBeFocused();

  await page.getByLabel("What's the business called?").fill("Elm Electric");
  await page.getByLabel("What's your trade?").selectOption("electrical");
  await page
    .getByLabel("What work do you take on?")
    .fill("Service calls, panel upgrades, EV chargers.");
  // Round 2 (FW): everything optional is folded away during setup.
  await page.getByText("More details, optional").click();
  await page
    .getByLabel("Things we should never promise")
    .fill("Same-day service\nA price over email");
  await page.getByLabel("People who always need you").fill("boss@bigGC.com");
  await page.getByLabel("Send me anything that mentions more than").fill("4000");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page).toHaveURL(/\/welcome\/learning/);
  await expect(page.getByText("Step 3 of 3")).toBeVisible();
  await expect(page.getByText("Reading the last 30 days of email…")).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByText("Elm Electric")).toBeVisible();
  await expect(page.getByText("Same-day service · A price over email")).toBeVisible();
  await expect(page.getByText("boss@biggc.com")).toBeVisible();
  await expect(page.getByText("$4,000")).toBeVisible();
});

test("settings shows the learned voice in plain words, and it can be corrected", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await testDb.insert(schema.voiceProfiles).values({
    workspaceId: owner.workspaceId,
    status: "ready",
    greetingStyle: "Hey",
    signoffStyle: "Thanks, Davi",
    avgLengthWords: 45,
    formality: "casual",
    phrasesUsed: ["sounds good", "I'll swing by"],
    phrasesAvoided: ["I hope this email finds you well"],
    examples: ["Hey [name], I can swing by Tuesday."],
    learnedFromCount: 120,
  });
  await signInAs(context, owner);

  await page.goto("/settings");
  await expect(
    page.getByText("You usually open with “Hey” and sign off “Thanks, Davi”.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Drafts will never say “I hope this email finds you well”."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Edit how I write" }).click();
  await page.getByLabel("How do you usually open?").fill("Morning");
  await page.getByRole("button", { name: "Save how I write" }).click();
  await expect(page).toHaveURL(/done=voice/);
  await expect(page.getByText("You usually open with “Morning”", { exact: false })).toBeVisible();
  await expect(
    page.getByText("You edited this, so the weekly refresh leaves it alone."),
  ).toBeVisible();
});

test("settings: a bad review link is refused in plain words, with focus on the field", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await signInAs(context, owner);

  await page.goto("/settings/profile");
  // Everything else valid, so the review link is the only (and first) field marked invalid.
  await page.getByLabel("What's the business called?").fill("Elm Electric");
  await page.getByLabel("What's your trade?").selectOption("electrical");
  await page.getByLabel("What work do you take on?").fill("Service calls, panel upgrades.");
  await page.getByLabel("Send me anything that mentions more than").fill("2500");
  await page.getByLabel("Your review link").fill("http://g.page/r/abc");
  await page.getByRole("button", { name: "Save business profile" }).click();

  await expect(page.getByLabel("Your review link")).toBeFocused();
  await expect(page.getByLabel("Your review link")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("That doesn't look like a web link")).toBeVisible();

  await page.getByLabel("Your review link").fill("");
  await page.getByRole("button", { name: "Save business profile" }).click();
  await expect(page).toHaveURL(/\/settings\?done=profile/);
});
