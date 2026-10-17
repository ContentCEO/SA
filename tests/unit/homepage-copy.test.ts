import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { faqs, features, pricingPromise, promiseBand } from "@/components/marketing/home-copy";
import { PlanCards } from "@/components/marketing/plan-cards";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { formatDollars, pricing } from "@/config/pricing";
import { EARN_THRESHOLD, GRACE_MINUTES, MAX_FOLLOWUPS } from "@/config/rules";
import { numberWord } from "@/lib/number-words";
import { firstChargeLine, PLAN_IDS } from "@/server/billing-rules";
import { TRIAL_NO_SEND_LINE, TRIAL_SIDE_DOOR_LINE } from "@/server/trial-email-rules";

/** The homepage's words, held to what the code does (wave 1, Homepage words). */
const flat = (s: string) => s.replace(/\s+/g, " ").replace(/&apos;/g, "'");
const copy = () => flat(readFileSync("src/components/marketing/home-copy.ts", "utf8"));
const feature = (title: string) => {
  const f = features.find((x) => x.title === title);
  expect(f, title).toBeDefined();
  return f!.body;
};
const faq = (q: string) => {
  const f = faqs.find((x) => x.q === q);
  expect(f, q).toBeDefined();
  return f!.a;
};

describe("Writes like you (Check 6 P1)", () => {
  it("says the drafts are written by AI and that a new price, day or promise is flagged", () => {
    const body = feature("Writes like you");
    expect(body).toContain("The drafts are written by AI");
    expect(body).toContain("it's flagged so you can check it before you send");
    expect(copy()).not.toContain("never invents");
  });
});

describe("autopilot FAQ (Check 6 P3)", () => {
  it("names the plans, the setup call, the earn rule and the hold from config", () => {
    const a = faq("Will it send emails without me?");
    expect(a).toContain(`${EARN_THRESHOLD} replies without changing a word`);
    expect(a).toContain(`${GRACE_MINUTES} minutes so you can stop it`);
    expect(a).toContain(pricing.plans.crew.name);
    expect(a).toContain(pricing.plans.company.name);
    expect(a).toContain("only after your setup call");
    expect(a).not.toContain("approved ten");
  });
});

describe("the promise band (Check 6 P7)", () => {
  const text = promiseBand.join(" ");

  it("gives the undo window from its constant and names autopilot as the one exception", () => {
    expect(text).toContain(`${UNDO_WINDOW_SECONDS} seconds`);
    expect(text).toContain("The only exception is autopilot");
  });

  it("keeps Davi's trial words (2026-10-16) word for word", () => {
    expect(text).toContain(`${TRIAL_NO_SEND_LINE}`);
    expect(text).toContain(TRIAL_SIDE_DOOR_LINE);
    expect(text).toContain("won't send anything to a customer");
  });

  it("no sentence is over 25 words", () => {
    for (const s of promiseBand) expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(25);
  });
});

describe("changing how you do email (Check 34 P6)", () => {
  it("says replies are read and sent in the Squared Away queue, drafts saved in Gmail too", () => {
    const a = faq("Do I have to change how I do email?");
    expect(a).toContain("Squared Away queue");
    expect(a).toContain("Gmail Drafts folder");
    expect(a).not.toMatch(/send (it |one )?from Gmail|works inside/i);
  });
});

describe("plan cards (Check 35 P2)", () => {
  it("each card states the first payment in /billing's words, with tax said once per card", () => {
    const html = renderToStaticMarkup(createElement(PlanCards)).replace(/&#x27;/g, "'");
    for (const id of PLAN_IDS) {
      const line = firstChargeLine(id, true);
      expect(html).toContain(line);
      expect(line).toContain(formatDollars(pricing.setupFee.amountCents));
      expect(line).toContain(formatDollars(pricing.plans[id].amountCents));
    }
    expect(html.match(/plus sales tax where it applies/g)).toHaveLength(PLAN_IDS.length);
    expect(html).not.toContain("Plus sales tax where it applies.");
  });
});

describe("rule numbers come from their constants (Check 35 P5)", () => {
  const all = () =>
    [...features.map((f) => f.body), ...faqs.map((f) => f.a), pricingPromise].join(" ");

  it("the nudge cap, the earn rule and the autopilot hold", () => {
    expect(all()).toContain(`${numberWord(MAX_FOLLOWUPS)} at most`);
    expect(pricingPromise).toContain(`${numberWord(MAX_FOLLOWUPS)} nudges at most`);
    expect(all()).toContain(`${EARN_THRESHOLD} replies without changing a word`);
    expect(pricingPromise).toContain(`${GRACE_MINUTES} minutes`);
  });

  it("no rule number is typed into the homepage or its copy", () => {
    for (const f of ["src/app/page.tsx", "src/components/marketing/home-copy.ts"]) {
      const src = flat(readFileSync(f, "utf8"));
      expect(src, f).not.toMatch(/\b(two|ten) (nudges|replies)|\b10 minutes|approved ten/i);
    }
  });

  it("the server keeps using the same constants", async () => {
    expect((await import("@/server/autopilot")).EARN_THRESHOLD).toBe(EARN_THRESHOLD);
    expect((await import("@/server/autopilot")).GRACE_MINUTES).toBe(GRACE_MINUTES);
    expect((await import("@/server/drafts")).MAX_FOLLOWUPS).toBe(MAX_FOLLOWUPS);
  });

  it("numberWord spells one to ten and leaves larger numbers as digits", () => {
    expect([1, 2, 10, 11, 14].map(numberWord)).toEqual(["one", "two", "ten", "11", "14"]);
  });
});
