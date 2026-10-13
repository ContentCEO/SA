import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegalDoc } from "@/components/marketing/legal-page";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { bodyRetentionDays } from "@/config/retention";
import { GMAIL_SCOPES } from "@/mailbox/gmail/scopes";
import { ACCESS_REMINDER_AFTER_MS, MAX_ACCESS_ALERTS } from "@/server/alerts";
import { MAX_SENT_EMAILS } from "@/server/voice";

/**
 * Plan M11 S5: the privacy policy and terms are rendered from docs/*.md, and every sentence in
 * them must be true of the code. These checks hold the wording to the code where the two can
 * drift (numbers, the deletion promise, Google's Limited Use wording, the scopes) and keep the
 * legal choices that are Davi's ([To confirm]) untouched.
 */

/** Markdown wraps lines; compare text with the line breaks and runs of spaces collapsed. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const raw = (file: string) => readFileSync(`docs/${file}`, "utf8");

/** Google's template sentence for the Limited Use disclosure, word for word. */
const LIMITED_USE_SENTENCE =
  "Squared Away's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.";

/** The deletion promise, shared word for word by the policy and the homepage FAQ. */
const DELETION_SENTENCE =
  "Delete my account in Settings deletes your account and everything in it from Squared Away, after one confirmation. Stripe keeps its own payment records.";

/** One bullet of a markdown list, from its bold label to the next bullet or heading. */
function bullet(doc: string, label: string): string {
  const start = doc.indexOf(`- **${label}**`);
  expect(start, `bullet "${label}"`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + 2);
  const end = rest.search(/\n(- |#)/);
  return flat(end === -1 ? rest : rest.slice(0, end));
}

function homepageFaq(question: string): string {
  const src = readFileSync("src/app/page.tsx", "utf8");
  const escaped = question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`q: "${escaped}",\\s*a:\\s*"([^"]+)"`));
  expect(m, `FAQ "${question}"`).not.toBeNull();
  return m![1];
}

afterEach(() => vi.unstubAllEnvs());

describe("legal documents render with every placeholder filled", () => {
  for (const file of ["privacy-policy.md", "terms.md"] as const) {
    for (const support of ["help@example.com", undefined]) {
      it(`${file}, SUPPORT_EMAIL ${support ? "set" : "unset"}`, async () => {
        vi.stubEnv("SUPPORT_EMAIL", support);
        const doc = await loadLegalDoc(file);
        expect(doc).not.toContain("{{");
        expect(doc).not.toContain("}}");
        expect(doc).toContain("Last updated:");
        expect(doc).toContain("**Draft — not yet reviewed.**");
        if (support) expect(doc).toContain(`mailto:${support}`);
        else expect(doc).not.toContain("Email:");
      });
    }
  }

  it("both carry the same 'Last updated' date", () => {
    const date = (f: string) => raw(f).match(/_Last updated: ([^_]+)_/)?.[1];
    expect(date("privacy-policy.md")).toBeTruthy();
    expect(date("terms.md")).toBe(date("privacy-policy.md"));
  });
});

describe("terms", () => {
  const terms = flat(raw("terms.md"));

  it("keeps Davi's three [To confirm] items exactly (refunds, liability, law)", () => {
    // The banner above the title explains the marker once; the body has exactly three.
    const body = terms.slice(terms.indexOf("# Terms of Service"));
    expect(body.match(/\[To confirm\]/g)).toHaveLength(3);
    expect(terms.match(/\[To confirm\]/g)).toHaveLength(4);
    expect(terms).toContain(
      "**[To confirm]** Whether the setup fee and the current month are refundable, and in which cases.",
    );
    expect(terms).toContain(
      "**[To confirm]** The limit of our liability (commonly the amount you paid in the 12 months before a claim) and which kinds of loss are excluded.",
    );
    expect(terms).toContain(
      "**[To confirm]** That these terms are governed by the laws of the Commonwealth of Massachusetts and where disputes are heard.",
    );
    // A legal choice for Davi, listed for him, not decided here.
    expect(terms).toContain("plus any taxes");
  });

  it("names no price: prices render from src/config/pricing.ts", () => {
    expect(terms).not.toMatch(/\$\s?\d/);
  });

  it("cancelling stops renewal at the end of the paid period; deleting cancels at once (as billing does)", () => {
    expect(terms).toContain("stays on until the end of the period you've paid for");
    expect(terms).toContain("**Delete my account** in Settings cancels your plan straight away.");
    expect(readFileSync("src/server/billing.ts", "utf8")).toContain(
      'subscription_cancel: { enabled: true, mode: "at_period_end" }',
    );
    const deletion = readFileSync("src/server/account-deletion.ts", "utf8");
    expect(deletion).toContain("cancelSubscriptionNow(");
  });

  it("the trial can't send to customers; practice copies go only to the owner", () => {
    expect(terms).toContain("sending to customers is switched off");
    expect(terms).toContain("practice copies, to your own address");
  });

  it("autopilot only on plans that include it, after setup, one kind of email at a time", () => {
    expect(terms).toContain(
      "only available on plans that include it, after your setup call, one kind of email at a time",
    );
  });
});

describe("privacy policy", () => {
  const policy = flat(raw("privacy-policy.md"));

  it("lists exactly the Gmail scopes the connect flow asks for", () => {
    const inDoc = new Set(raw("privacy-policy.md").match(/`gmail\.[a-z]+`/g));
    const asked = new Set(
      Object.values(GMAIL_SCOPES).map((u) => `\`${u.replace(/^.*\/auth\//, "")}\``),
    );
    expect([...inDoc].sort()).toEqual([...asked].sort());
    expect(asked.size).toBe(3);
    // Sign-in is identity only.
    expect(policy).toContain("(`openid`, `email`, `profile`)");
  });

  it("uses Google's Limited Use template sentence and the explicit-permission merger wording", () => {
    expect(policy).toContain(LIMITED_USE_SENTENCE);
    expect(policy).toContain(
      "if the business is merged or sold, only after asking for your explicit permission first",
    );
    expect(policy).not.toContain("with your rights protected");
  });

  it("describes voice learning as it runs: up to 200 sent emails, re-read weekly, never stored", () => {
    expect(policy).not.toMatch(/read once/i);
    expect(MAX_SENT_EMAILS).toBe(200);
    expect(policy).toContain(`up to ${MAX_SENT_EMAILS} of your sent emails from the last year`);
    expect(policy).toContain(
      "again about once a week (skipped if you have edited your style yourself)",
    );
    expect(policy).toContain("**Re-learn from my sent mail**");
    expect(policy).toContain("never stored");
  });

  it("mentions practice sends, the monthly summary, the Gmail alert, Twilio and the speech service", () => {
    expect(policy).toMatch(/practice copy/i);
    expect(policy).toContain("monthly summary");
    expect(MAX_ACCESS_ALERTS).toBe(2);
    expect(ACCESS_REMINDER_AFTER_MS).toBe(2 * 86_400_000);
    expect(policy).toContain("(plus one reminder two days later)");
    expect(policy).toContain("**Twilio**");
    expect(policy).toContain("speech service (run by Google or Apple");
    expect(policy).toContain(`You then have ${UNDO_WINDOW_SECONDS} seconds to undo it`);
  });

  it("names every processor", () => {
    for (const p of ["Google", "Anthropic", "Vercel", "Neon", "Inngest", "Stripe", "Resend"]) {
      expect(policy).toContain(`**${p}**`);
    }
    expect(policy).toContain("**Sentry** — only if switched on");
    expect(policy).toContain("**Your browser's push service**");
  });

  it("retention matches the purge: 30 days for text, flags and pulled-out addresses/dates", () => {
    expect(bodyRetentionDays()).toBe(30);
    const kept = bullet(raw("privacy-policy.md"), "Email text");
    expect(kept).toContain("draft text and the check notes on drafts");
    expect(kept).toContain("The street address, dates and inspector's corrections");
    expect(kept).toContain("deleted after 30 days");
  });

  it("disconnect: edit counts go with the mailbox; style, suggestions, details, activity, usage stay", () => {
    const d = bullet(raw("privacy-policy.md"), "Disconnect Gmail");
    expect(d).toContain("the counts of what you changed in those drafts");
    expect(d).toContain(
      "Your writing style and any style suggestions waiting for you, your business details, your activity history and your AI usage counts stay",
    );
  });

  it("delete my account: the shared sentence, the invite, Stripe, and the waitlist left for the owner to ask", () => {
    const d = bullet(raw("privacy-policy.md"), "Delete my account");
    // The policy's bullet reads "**Delete my account** (Settings): deletes …".
    expect(flat(`Delete my account in Settings ${d.split("(Settings): ")[1]}`)).toContain(
      DELETION_SENTENCE,
    );
    expect(d).toContain("removes your invite");
    expect(d).toContain("cancels your subscription straight away");
    expect(d).toContain(
      "This doesn't remove a waitlist entry or Growth call request you sent from our website",
    );
    // …because the code doesn't (amendment 2: a waitlist row may hold a Growth request).
    const code = readFileSync("src/server/account-deletion.ts", "utf8");
    expect(code).toContain("tx.delete(invites)");
    expect(code).not.toMatch(/delete\(waitlist\)/);
  });

  it("Stripe gets the business name, or the owner's name when none is set (as billing sends)", () => {
    expect(policy).toContain(
      "It receives your email address and your business name (or your name, if no business name is set)",
    );
    expect(bullet(raw("privacy-policy.md"), "Delete my account")).toContain(
      "your email address and your business name, or your name if no business name is set",
    );
    expect(readFileSync("src/server/billing.ts", "utf8")).toContain(
      "name: workspace.businessName ?? owner?.name ?? undefined,",
    );
  });

  it("the cost alert to us is described with everything it carries", () => {
    expect(policy).toContain("the account's AI cost, plan price and usage counts");
  });

  it("says nothing about referrals while they are switched off", () => {
    expect(policy).not.toMatch(/referr/i);
  });
});

describe("homepage FAQ", () => {
  it("the deletion answer says exactly what the policy says", () => {
    const a = homepageFaq("What if I stop?");
    expect(a).toContain(DELETION_SENTENCE);
    expect(a).not.toMatch(/in one tap|everything we hold/);
  });

  it("the trial answer doesn't claim nothing at all can be sent", () => {
    const a = homepageFaq("What does the trial look like?");
    expect(a).toContain("nothing can go to a customer during the trial");
  });

  it("the Gmail-access answer matches the policy: 30 days, then new mail, and the sent mail read", () => {
    const a = homepageFaq("Can it see all my email?");
    expect(a).not.toContain("only reads the last 30 days");
    expect(a).toContain(
      "When you connect, it reads the last 30 days of your email (the text only for your inbox), then new mail as it arrives",
    );
    expect(a).toContain(`up to ${MAX_SENT_EMAILS} of your sent emails from the last year`);
    expect(a).toContain(`It keeps email text for ${bodyRetentionDays()} days.`);
  });
});

describe("owner-facing copy about the trial", () => {
  // Practice copies to the owner's own address go out through gmail.send during the trial, so
  // no screen may say sending is off altogether (the policy's scope table says otherwise).
  const screens = ["src/app/page.tsx", "src/app/(app)/connect/page.tsx"];

  it("never says sending is switched off completely", () => {
    for (const f of screens) {
      expect(flat(readFileSync(f, "utf8")), f).not.toMatch(/switched off completely/);
    }
  });

  it("the pre-consent Gmail explainer says only customers are off-limits during the trial", () => {
    expect(flat(readFileSync("src/app/(app)/connect/page.tsx", "utf8"))).toContain(
      "nothing can go to a customer: you can only send yourself practice copies.",
    );
  });
});
