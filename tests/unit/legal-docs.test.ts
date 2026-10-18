import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { faqs, features } from "@/components/marketing/home-copy";
import { MAX_FOLLOWUPS } from "@/config/rules";
import { numberWord } from "@/lib/number-words";
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

/** A homepage FAQ answer as visitors read it (src/app/page.tsx renders home-copy.ts). */
function homepageFaq(question: string): string {
  const f = faqs.find((x) => x.q === question);
  expect(f, `FAQ "${question}"`).toBeDefined();
  return f!.a;
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
    // Davi, 2026-10-14: Stripe Tax. Prices are tax-exclusive, so tax goes on top, as written.
    expect(terms).toContain("plus any taxes");
    expect(readFileSync("src/server/billing.ts", "utf8")).toContain(
      'const TAX_BEHAVIOR = "exclusive" as const;',
    );
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

  it("Squared Away sends nothing to customers in the trial; the Gmail side door is said (2026-10-16)", () => {
    expect(terms).toContain(
      "it won't send anything to a customer: its own sending is switched off",
    );
    expect(terms).toContain("practice copies, to your own address");
    expect(terms).toContain(
      "Your drafts are real Gmail drafts, in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want",
    );
    expect(terms).not.toContain("sending to customers is switched off");
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
    // gmail.readonly and gmail.compose; gmail.send was dropped on 2026-10-15.
    expect(asked.size).toBe(2);
    expect(policy).toContain("We ask Google for two Gmail permissions");
    expect(policy).toContain(
      "If you untick either of these on Google's screen, we remove what was granted and save nothing.",
    );
    // Owners who connected before still see the old permission listed at Google.
    expect(policy).toContain('"Send email on your behalf"');
    expect(policy).toContain("disconnecting Gmail in Settings removes all of our access");
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

  it("the billing address Stripe asks for (sales tax) is named, and we don't keep it", () => {
    expect(policy).toContain(
      "Its checkout page may also ask for your billing address, which Stripe uses to work out sales tax; Squared Away doesn't store it.",
    );
    // As billing does: Stripe collects it at checkout; no column of ours holds an address.
    expect(readFileSync("src/server/billing.ts", "utf8")).toContain(
      'billing_address_collection: "required"',
    );
    expect(readFileSync("src/db/schema.ts", "utf8")).not.toMatch(/billing_address|billingAddress/);
  });

  it("what Stripe keeps after deletion includes the tax-time address and name (as checkout saves them)", () => {
    // With tax on, checkout saves the address and the typed name onto Stripe's customer, and
    // deleting an account only cancels the subscription: that record stays at Stripe.
    const billing = readFileSync("src/server/billing.ts", "utf8");
    expect(billing).toContain('customer_update: { address: "auto", name: "auto" }');
    expect(readFileSync("src/server/account-deletion.ts", "utf8")).not.toMatch(/customers\.del/);
    expect(flat(policy)).toContain(
      "Stripe saves that address, and the name you enter there, on its customer record of you.",
    );
    expect(flat(bullet(raw("privacy-policy.md"), "Delete my account"))).toContain(
      "if you paid while sales tax was on, also the billing address you entered on Stripe's checkout page, and the name you entered there in place of the one we sent",
    );
  });

  it("the cost alert to us is described with everything it carries", () => {
    expect(policy).toContain("the account's AI cost, plan price and usage counts");
  });

  it("round 2 (TC): breach notice, where it's processed, what goes to the AI, reasons kept", () => {
    expect(policy).toContain("as Massachusetts law (Chapter 93H) requires");
    expect(policy).toContain("**Where it's processed:** Squared Away runs in the United States.");
    // The classifier is shown the sender and the subject, not only the text.
    expect(policy).toContain("with each one's sender (name and email address) and subject");
    const classify = readFileSync("src/ai/prompts/classify.v4.ts", "utf8");
    expect(classify).toContain("Sender: ${from");
    expect(classify).toContain("Subject: ${e.subject");
    // Needs-you and draft reasons are not purged with the text, so they're named as kept.
    expect(policy).toContain("a one-line reason when something needs you");
    expect(
      bullet(
        raw("privacy-policy.md"),
        "Who, when (including a form's Reply-To address), subject, summaries, the one-line reasons and categories",
      ),
    ).toContain("kept so your inbox");
    // Voice examples: names depend on the AI; our code scrubs the rest.
    expect(policy).not.toContain("placeholders in place of names");
    expect(policy).toContain(
      "our own code also replaces any email addresses, phone numbers, prices and street addresses",
    );
  });

  it("round 2 (FW): the emails we send and the notices we get are all named", () => {
    expect(policy).toContain("your invite with the sign-in link");
    expect(policy).toContain('a one-time "your first drafts are ready" email');
    expect(policy).toContain(
      "when someone pays (it names only the plan and whether the setup fee was included)",
    );
    expect(policy).toContain("when you marked a conversation as answered by phone");
    expect(policy).not.toMatch(/book a free/i);
  });

  it("names what the outside-review fixes store or measure (Reply-To, sign-up source, emails, analytics)", () => {
    // A form's Reply-To is stored with the other message metadata.
    expect(policy).toContain('the "Reply-To" a website form sets');
    expect(readFileSync("src/db/schema.ts", "utf8")).toContain('jsonb("reply_to_header")');
    // Where a sign-up came from, as the source fields hold it.
    expect(policy).toContain("(`utm_source`, `utm_medium`, `utm_campaign`)");
    expect(policy).toContain("the name of the website that sent you, not the page");
    expect(readFileSync("src/server/source-rules.ts", "utf8")).toContain(
      'SOURCE_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "referrer_host"]',
    );
    // The confirmation and the content-free notice.
    expect(policy).toContain("We email you once to confirm you're on the list");
    expect(policy).toContain("the email confirming you joined the waitlist");
    // Web Analytics on the public pages only, without cookies.
    expect(policy).toContain("with Vercel Web Analytics. It sets no cookies");
    expect(policy).toContain("It never runs on the signed-in app.");
    expect(readFileSync("src/lib/analytics-rules.ts", "utf8")).toContain(
      'COUNTED_PATHS = ["/", "/growth", "/privacy", "/terms"]',
    );
  });

  it("says nothing about referrals while they are switched off, but the Growth request's code", () => {
    // Davi, 2026-10-16: a Growth request can carry a referral code (stored only while referrals
    // are on). That one sentence is in now; the rest waits in docs/SETUP.md §6d step 3.
    const GROWTH_REFERRAL_LINE =
      "If you followed another Squared Away owner's referral link while we offer referrals, we keep that link's code with your request, so that owner can be thanked once if you become a Growth client.";
    expect(policy.replace(/\s+/g, " ")).toContain(GROWTH_REFERRAL_LINE);
    expect(policy.replace(/\s+/g, " ").replace(GROWTH_REFERRAL_LINE, "")).not.toMatch(/referr/i);
  });
});

describe("homepage FAQ", () => {
  it("the Gmail Drafts answer doesn't point to sending from Gmail (the trial's side door)", () => {
    const a = homepageFaq("Do I have to change how I do email?");
    expect(a).not.toMatch(/send from either place/i);
    expect(a).toContain("Gmail Drafts folder");
  });

  it("answers why not Gmail's own AI or Jobber, second, in plain words (Check 34 P1)", () => {
    const q = "How is this different from Gmail's own AI, or from Jobber?";
    expect(faqs[1].q).toBe(q);
    const a = homepageFaq(q);
    expect(a).toContain("price list");
    expect(a).toContain("building-department");
    expect(a).toContain("without your okay");
    expect(a).not.toMatch(/only one|unlike any|best|never sends anything/i);
    expect(a).not.toContain('"');
  });

  it("the deletion answer says exactly what the policy says", () => {
    const a = homepageFaq("What if I stop?");
    expect(a).toContain(DELETION_SENTENCE);
    expect(a).not.toMatch(/in one tap|everything we hold/);
  });

  it("the trial answer doesn't claim nothing at all can be sent", () => {
    const a = homepageFaq("What does the trial look like?");
    expect(a).toContain("Squared Away won't send anything to a customer during the trial");
  });

  it("the Gmail-access answer matches the policy: 30 days, then new mail, and the sent mail read", () => {
    const a = homepageFaq("Can it see all my email?");
    expect(a).not.toContain("only reads the last 30 days");
    expect(a).toContain(
      "When you connect, it reads the last 30 days of your email (the text only for your inbox), then new mail as it arrives",
    );
    expect(a).toContain(`up to ${MAX_SENT_EMAILS} of your sent emails from the last year`);
    // Check 6 P2: bodies are purged; who, when, subject and summaries stay (as the policy says).
    expect(a).toContain(`It deletes the body of each email after ${bodyRetentionDays()} days.`);
    expect(a).toContain("It has no permission to delete, archive or move your emails.");
  });
});

describe("owner-facing copy about the trial", () => {
  // Practice copies to the owner's own address go out (through gmail.compose) during the trial, so
  // no screen may say sending is off altogether (the policy's scope table says otherwise).
  const screens = [
    "src/app/page.tsx",
    "src/components/marketing/home-copy.ts",
    "src/app/(app)/connect/page.tsx",
  ];

  it("never says sending is switched off completely", () => {
    for (const f of screens) {
      expect(flat(readFileSync(f, "utf8")), f).not.toMatch(/switched off completely/);
    }
  });

  it("the pre-consent Gmail explainer says only customers are off-limits during the trial", () => {
    expect(flat(readFileSync("src/app/(app)/connect/page.tsx", "utf8"))).toContain(
      "Squared Away won&apos;t send anything to a customer: from Squared Away you can only send yourself practice copies. Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want.",
    );
  });

  it("no public or trial screen says nothing sends at all, or calls nudges automatic", () => {
    // Practice copies go out during the trial; and every nudge is a draft the owner okays.
    const files = [
      "src/app/page.tsx",
      "src/components/marketing/home-copy.ts",
      "src/app/(app)/connect/page.tsx",
      "src/components/app/status-banner.tsx",
      "src/components/app/trial-clock.tsx",
      "src/components/marketing/queue-preview.tsx",
    ];
    for (const f of files) {
      const text = flat(readFileSync(f, "utf8")).toLowerCase();
      for (const bad of [
        "nothing sends",
        "nothing can go to a customer",
        "two at most, ever",
        "automatic nudge",
        "takes two minutes",
        // The cap counts nudges sent; a discarded one doesn't count, so never promise drafts.
        "nudge drafts at most",
        "sending is off",
        // Check 6 P1: checkDraft flags after the fact; it can't stop the AI inventing.
        "never invents",
        // Check 6 P2: email is used for sorting, quotes, money and customers too; and the
        // compose permission removes the drafts it wrote.
        "only used to write your replies",
        "can't delete, archive or move anything",
      ]) {
        expect(text, `${f}: ${bad}`).not.toContain(bad);
      }
    }
  });

  it("the homepage says replies are drafted in the owner's voice, not their own words (Check 6 P8)", () => {
    for (const f of ["src/app/page.tsx", "src/components/marketing/home-copy.ts"]) {
      expect(flat(readFileSync(f, "utf8")).toLowerCase(), f).not.toContain("in your own words");
    }
  });

  it("the homepage states the nudge cap the code keeps (nudges sent, each a draft)", () => {
    // Check 34 P3: and only where the customer emailed and the owner emailed back.
    expect(features.find((f) => f.title === "Chases quiet quotes")?.body).toContain(
      `it drafts a friendly nudge, ${numberWord(MAX_FOLLOWUPS)} at most, each one waiting for your okay.`,
    );
  });

  it("the explainer names Google's two permissions as Google does, and keeps the Send reply promise", () => {
    const page = flat(readFileSync("src/app/(app)/connect/page.tsx", "utf8"));
    expect(page).toContain("Google will ask you to allow two things");
    expect(page).toContain("<strong>View your email messages and settings</strong>");
    expect(page).toContain("<strong>Manage drafts and send emails</strong>");
    expect(page).toContain("Leave both ticked.");
    // The Send reply promise, with the owner's own autopilot switch (as the privacy policy's
    // compose row and the verification doc say): never an absolute "only when you tap".
    expect(page).toContain(
      "it still goes out only when you tap <strong>Send reply</strong> (or by autopilot, if you switch it on for a kind of email).",
    );
    expect(page).toContain(
      "Send a reply only when you tap <strong>Send reply</strong>, or by autopilot if you switch it on for a kind of email.",
    );
    expect(page).not.toMatch(/only when you tap <strong>Send reply<\/strong>\./);
    expect(page).not.toMatch(/three things|all three|read, draft, and send/);
  });

  it("names what the leads package stores and promises (lead sources, Call / Text, towns)", () => {
    const policy = flat(raw("privacy-policy.md"));
    expect(policy).toContain(
      "Which lead website or phone service a conversation came through (for example Thumbtack or Google Voice)",
    );
    expect(policy).toContain("the towns you work in");
    expect(policy).toContain(
      "To show **Call** and **Text** buttons, we look for a phone number in the customer's email when you open your queue. We don't store the number. Calls and texts go from your own phone: Squared Away never calls or texts your customers.",
    );
    expect(policy).toContain(
      "we never draft or send to an email-to-text address, because that would text your customer.",
    );
    expect(policy).toContain("lead-source, done and fixed marks");
  });

  it("names what the replies package stores and sends (first replies, emergencies, money totals)", async () => {
    const policy = flat(raw("privacy-policy.md"));
    const { EMERGENCY_ALERTS, emergencyAlertText } = await import("@/server/emergency-alert-rules");
    expect(policy).toContain("which kind of first reply the draft is");
    expect(policy).toContain("when we let your phone know about an emergency email");
    expect(policy).toContain("first-reply labels, when we alerted you to an emergency");
    expect(policy).toContain("**Emergencies, even at night**");
    // The words and caps the code keeps.
    expect(emergencyAlertText(1)).toContain("An emergency email just came in.");
    expect(policy).toContain('It says only "An emergency email just came in."');
    expect(policy).toContain(
      `at most ${EMERGENCY_ALERTS.nightCap} a night and ${EMERGENCY_ALERTS.dayCap} a day`,
    );
    expect(policy).toContain(
      "this month's money so far as totals (quotes you won, invoices paid and what's still owed)",
    );
    expect(policy).toContain("It's a draft like any other and waits for your **Send reply**.");
  });
});
