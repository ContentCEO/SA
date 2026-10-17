import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstDraftsEmailCopy, inviteEmailCopy } from "@/server/first-week-rules";
import { sendingBlockedReason, sendingOffLabel } from "@/server/lifecycle";
import { pushSummaryText } from "@/server/push-alerts";
import {
  TRIAL_NO_SEND_LINE,
  TRIAL_SIDE_DOOR_LINE,
  trialEmailCopy,
} from "@/server/trial-email-rules";

/** Davi's answers of 2026-10-16: the words that must stay true. */
const flat = (s: string) => s.replace(/\s+/g, " ").replace(/&apos;/g, "'");
const read = (f: string) => flat(readFileSync(f, "utf8"));

describe("homepage headline (Davi's exact words)", () => {
  it("the hero, both share descriptions and the share card say it; the old line is gone", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("Built for carpenters, plumbers, and electricians </p>");
    expect(page).toContain(
      '"Built for carpenters, plumbers, and electricians. Sorts your business email, drafts replies in your voice, and waits for your okay before anything goes out."',
    );
    expect(page).toContain(
      '"Built for carpenters, plumbers, and electricians. Nothing goes out without your okay."',
    );
    expect(read("src/app/opengraph-image.tsx")).toContain(
      "Built for carpenters, plumbers, and electricians. Nothing goes out without your okay.",
    );
    for (const f of ["src/app/page.tsx", "src/app/opengraph-image.tsx"])
      expect(read(f), f).not.toContain("the trades they work with");
  });
});

describe("the trial's side door stays (Davi): Squared Away sends nothing, the drafts are in Gmail", () => {
  it("the two lines", () => {
    expect(TRIAL_NO_SEND_LINE).toBe(
      "During your three-day trial, Squared Away won't send anything to a customer.",
    );
    expect(TRIAL_SIDE_DOOR_LINE).toBe(
      "Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want.",
    );
  });

  // Every place that describes the trial says it (literally, or through the constant).
  const SAYS_IT: Record<string, string> = {
    "src/components/marketing/home-copy.ts": TRIAL_SIDE_DOOR_LINE,
    "src/app/(app)/connect/page.tsx": TRIAL_SIDE_DOOR_LINE,
    "src/components/app/trial-clock.tsx": "{TRIAL_SIDE_DOOR_LINE}",
    "src/app/(app)/welcome/learning/page.tsx": "${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}",
    "src/app/(app)/billing/page.tsx": "{TRIAL_NO_SEND_LINE} {TRIAL_SIDE_DOOR_LINE}",
    "docs/privacy-policy.md": TRIAL_SIDE_DOOR_LINE,
    "docs/terms.md":
      "Your drafts are real Gmail drafts, in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want",
  };
  for (const [file, line] of Object.entries(SAYS_IT)) {
    it(`${file} says it`, () => {
      expect(read(file)).toContain(line);
    });
  }

  it("the emails say it: the invite, the first-drafts (day 1) email and the trial emails", () => {
    const invite = inviteEmailCopy({ signInUrl: "u", operatorFirstName: "Davi", phone: "p" });
    expect(invite.lines).toContain(TRIAL_SIDE_DOOR_LINE);
    expect(invite.lines.join(" ")).toContain("won't send anything to a customer");
    const day1 = firstDraftsEmailCopy({ queueUrl: "u", drafts: 3, trial: true });
    expect(day1.lines).toContain(`${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}`);
    // A paid account's first-drafts email doesn't talk about a trial.
    expect(firstDraftsEmailCopy({ queueUrl: "u", drafts: 3 }).lines.join(" ")).not.toContain(
      "trial",
    );
    const counts = { sorted: 1, drafted: 1, waitingDrafts: 1, needsYou: 0 };
    expect(trialEmailCopy("day2", { counts, queueUrl: "q", billingUrl: "b" }).lines).toContain(
      `${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}`,
    );
  });

  it("the draft card: Squared Away's Send reply is off, and the draft is in Gmail too", () => {
    const trial = { status: "evaluating", evaluationEndsAt: new Date(Date.now() + 86_400_000) };
    expect(sendingOffLabel({ ...trial, setupPaidVia: null } as never)).toBe(
      "Send reply is off during your three days",
    );
    expect(sendingBlockedReason({ ...trial, setupPaidVia: null } as never)).toContain(
      "in your Gmail Drafts folder too, if you'd rather send it from Gmail yourself",
    );
    // Phone notifications never say a reply can't be sent: "ready to check".
    expect(pushSummaryText({ replies: 2, needsYou: 0, canSend: false })).toBe(
      "2 replies ready to check",
    );
  });

  it("no line says or implies a draft can't be sent at all, or that nothing can leave Gmail", () => {
    const files = [
      "src/app/page.tsx",
      "src/components/marketing/home-copy.ts",
      "src/app/(app)/connect/page.tsx",
      "src/components/app/status-banner.tsx",
      "src/components/app/trial-clock.tsx",
      "src/components/marketing/queue-preview.tsx",
      "src/app/(app)/welcome/learning/page.tsx",
      "src/app/(app)/billing/page.tsx",
      "src/server/first-week-rules.ts",
      "src/server/trial-email-rules.ts",
      "src/server/lifecycle.ts",
      "src/server/push-alerts.ts",
      "docs/terms.md",
      "docs/privacy-policy.md",
    ];
    for (const f of files) {
      const text = read(f).toLowerCase();
      for (const bad of [
        "nothing goes to a customer",
        "nothing can go to a customer",
        "nothing can leave",
        "can't be sent",
        "cannot be sent",
        "sending is off during",
        "sending to customers is switched off",
        "sending is switched off completely",
        // Practice copies are only what Squared Away itself can send in the trial.
        "customer: you can only send yourself practice copies",
      ]) {
        expect(text, `${f}: ${bad}`).not.toContain(bad);
      }
    }
  });
});
