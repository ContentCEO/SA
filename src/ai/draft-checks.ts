/**
 * Code-level spot checks on every draft. The prompt tells the model not to
 * invent prices, dates or promises; these catch it when it does anyway. They
 * never rewrite the draft — they flag it for the owner and lower confidence.
 */
import { withoutGaps } from "./gaps";

const FILLER = [
  "i hope this email finds you well",
  "i hope this finds you well",
  "thank you for reaching out",
  "please don't hesitate",
  "please do not hesitate",
  "per my last email",
  "kindly",
  "just bumping this",
  "just circling back",
  "just following up on my last",
  "friendly reminder",
];

const DAYS =
  /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b|\b(tomorrow|tonight|this (morning|afternoon|evening|week(end)?)|next week)\b/gi;
const TIMES = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(noon|midnight)\b/gi;
const DATES =
  /\b\d{1,2}\/\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(st|nd|rd|th)?\b/gi;

/** Every dollar figure: "$1,450", "$95.00", "450 dollars", "450 bucks". */
function money(text: string): number[] {
  const out = [
    ...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g),
    ...text.matchAll(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/gi),
  ];
  return out.map((m) => Number(m[1]!.replace(/,/g, "")));
}

/** Words that make a commitment the owner has to stand behind. */
const COMMITMENT =
  /\b(guarantee[sd]?|guaranteeing|warrant(?:y|ies|ied)|promise[sd]?|promising)\b/gi;

function lowerWords(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ");
}

export type CheckContext = {
  /** Everything the draft is allowed to draw facts from: the conversation and the business profile. */
  sourceText: string;
  doNotPromise: string[];
  phrasesAvoided: string[];
  /** The owner's own "Never say this" list (plan #23). */
  neverSay?: string[];
  /**
   * Deposit and review-request drafts only (A4): percentages, dollar amounts, payment methods
   * and incentives must come from the owner — `termsSource` or `ownerWrote` — never from
   * `sourceText`, which holds the customer's emails too ("can I pay by Venmo?" is not
   * the owner agreeing to Venmo). Off for ordinary replies, so "let me check" or "card"
   * never flags an everyday draft.
   */
  checkTerms?: boolean;
  /** The owner's written terms (payment terms, policies, price list). Read loosely: "check or card". */
  termsSource?: string;
  /**
   * What the owner wrote to this customer themselves. A way to pay only counts when it is
   * said the way a draft would say it ("by check", not "let me check").
   */
  ownerWrote?: string;
  /** Review requests only: the one link allowed, and nothing offered in return. */
  review?: { url: string | null };
};

/** What kind of problem each flag is, so the caller can decide to regenerate. */
export type CheckHit =
  "money" | "when" | "commitment" | "never_promise" | "never_say" | "filler" | "terms";
export type CheckResult = { flags: string[]; confidenceCap: number; hits: CheckHit[] };

/**
 * Hits worth one fresh attempt before flagging (plan #23, #43): an invented price
 * or date, something the owner explicitly banned, or payment terms they never set (A4).
 */
export const REGENERATE_ON: CheckHit[] = ["money", "when", "never_promise", "never_say", "terms"];

/** "50%", "12.5 %". */
const PERCENT = /\b\d+(?:\.\d+)?\s?%/g;
const pct = (s: string) => s.replace(/\s+/g, "");

/**
 * Payment methods, each as [label, how the draft says it, what in the terms allows it].
 * The draft side needs a payment context ("by check", not "let me check"); the terms side
 * is looser, so terms of "check or card" allow "by check" and "credit card".
 */
const METHODS: [string, RegExp, RegExp][] = [
  ["Zelle", /\bzelle\b/i, /\bzelle\b/i],
  ["Venmo", /\bvenmo\b/i, /\bvenmo\b/i],
  ["PayPal", /\bpay\s?pal\b/i, /\bpay\s?pal\b/i],
  ["Cash App", /\bcash\s?app\b/i, /\bcash\s?app\b/i],
  ["ACH", /\bach\b/i, /\bach\b/i],
  ["wire transfer", /\bwire transfer\b/i, /\bwire\b/i],
  ["e-transfer", /\be-?transfer\b/i, /\be-?transfer\b/i],
  [
    "check",
    /\b(?:by|with|via|send|mail|write|pay(?:ing)?(?: with| by)?)\s+(?:a\s+)?(?:check|cheque)s?\b/i,
    /\b(?:check|cheque)s?\b/i,
  ],
  ["credit card", /\bcredit card\b/i, /\bcards?\b/i],
  ["debit card", /\bdebit card\b/i, /\bcards?\b/i],
  // "by card" / "pay with a card" (credit and debit have their own labels above).
  ["card", /\b(?:by|with|via)\s+(?:a\s+)?card\b/i, /\bcards?\b/i],
  ["cash", /\bcash\b(?!\s?app)/i, /\bcash\b(?!\s?app)/i],
];

/** Something offered in return. "Feel free to call" is not an incentive; "free of charge" is. */
const INCENTIVES: [string, RegExp][] = [
  ["discount", /\bdiscount/i],
  ["% off", /%\s?off\b/i],
  ["off your", /\boff your\b/i],
  ["coupon", /\bcoupon/i],
  ["gift card", /\bgift ?cards?\b/i],
  ["free", /\bfree\b(?!\s+to\b)/i],
];

const URL = /\bhttps?:\/\/[^\s<>"'()]+/gi;
const sameUrl = (a: string, b: string) =>
  a.replace(/[.,!?;:]+$/, "").replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/** Whether the text links to `url` (a trailing slash or full stop doesn't matter). */
export function hasLink(text: string, url: string): boolean {
  return [...text.matchAll(URL)].some((m) => sameUrl(m[0], url));
}

export function checkDraft(draftBody: string, ctx: CheckContext): CheckResult {
  // Placeholders ({{price}}…) are gaps for the owner, not facts — check the words around them.
  const body = withoutGaps(draftBody);
  const flags: string[] = [];
  const hits: CheckHit[] = [];
  let cap = 1;
  const lowerBody = body.toLowerCase();
  const source = ctx.sourceText.toLowerCase();

  // Prices that appear nowhere in the conversation or the profile were made up.
  const known = new Set(money(ctx.sourceText));
  const invented = [...new Set(money(body))].filter((a) => !known.has(a));
  if (invented.length) {
    flags.push(
      `Mentions ${invented.map((a) => `$${a.toLocaleString("en-US")}`).join(", ")} — that price isn't in the email or your profile. Check it.`,
    );
    cap = Math.min(cap, 0.3);
    hits.push("money");
  }

  // Days, dates and times the customer didn't bring up are commitments.
  const whenInBody = [...body.matchAll(DAYS), ...body.matchAll(TIMES), ...body.matchAll(DATES)].map(
    (m) => m[0].toLowerCase(),
  );
  const newWhen = [...new Set(whenInBody)].filter((w) => !source.includes(w));
  if (newWhen.length) {
    flags.push(`Mentions “${newWhen.join("”, “")}” — make sure you can commit to that.`);
    cap = Math.min(cap, 0.5);
    hits.push("when");
  }

  // Guarantee / warranty / promise language the customer and profile never used.
  const commitments = [
    ...new Set([...body.matchAll(COMMITMENT)].map((m) => m[0].toLowerCase())),
  ].filter((w) => !source.includes(w));
  if (commitments.length) {
    flags.push(`Says “${commitments.join("”, “")}” — make sure you stand behind that.`);
    cap = Math.min(cap, 0.4);
    hits.push("commitment");
  }

  // Never-promise list: flag when the key words of an item all show up in the draft.
  for (const item of ctx.doNotPromise) {
    const words = lowerWords(item)
      .split(" ")
      .filter((w) => w.length > 3);
    if (words.length && words.every((w) => lowerWords(body).includes(w))) {
      flags.push(`Looks like it promises “${item}”, which is on your never-promise list.`);
      cap = Math.min(cap, 0.2);
      hits.push("never_promise");
    }
  }

  // The owner's never-say list: any listed phrase, anywhere, any case.
  for (const phrase of ctx.neverSay ?? []) {
    const p = phrase.trim().toLowerCase();
    if (p && lowerBody.includes(p)) {
      flags.push(`Says “${phrase.trim()}”, which is on your never-say list.`);
      cap = Math.min(cap, 0.2);
      hits.push("never_say");
    }
  }

  if (ctx.checkTerms) {
    // Terms the owner never wrote down: a percentage, a way to pay, or something offered.
    // Only the owner's own words count — never the customer's.
    const terms = ctx.termsSource ?? "";
    const owner = ctx.ownerWrote ?? "";
    const ownerSaid = `${terms}\n${owner}`;
    const sourcePct = new Set([...ownerSaid.matchAll(PERCENT)].map((m) => pct(m[0])));
    // An amount the customer named ("I'll send a $500 deposit") isn't a term either. Amounts
    // found nowhere at all are already flagged above as invented prices.
    const ownerAmounts = new Set(money(ownerSaid));
    const customerAmounts = [...new Set(money(body))].filter(
      (a) => known.has(a) && !ownerAmounts.has(a),
    );
    const newTerms = [
      ...[...new Set([...body.matchAll(PERCENT)].map((m) => pct(m[0])))].filter(
        (p) => !sourcePct.has(p),
      ),
      ...customerAmounts.map((a) => `$${a.toLocaleString("en-US")}`),
      ...METHODS.filter(
        ([, inBody, inTerms]) => inBody.test(body) && !inTerms.test(terms) && !inBody.test(owner),
      ).map(([label]) => label),
      ...INCENTIVES.filter(
        // A review request never offers anything, whatever the profile says.
        ([, re]) => re.test(body) && (!!ctx.review || !re.test(ownerSaid)),
      ).map(([label]) => label),
    ];
    if (newTerms.length) {
      flags.push(
        ctx.review
          ? `Mentions “${newTerms.join("”, “")}” — a review request never offers or asks for anything else. Check it.`
          : `Mentions “${newTerms.join("”, “")}” — that isn't in your payment terms. Check it.`,
      );
      cap = Math.min(cap, 0.3);
      hits.push("terms");
    }
  }
  if (ctx.review) {
    const others = [...new Set([...body.matchAll(URL)].map((m) => m[0]))].filter(
      (u) => !ctx.review!.url || !sameUrl(u, ctx.review!.url),
    );
    if (others.length) {
      flags.push("Has a link that isn't your review link. Check it.");
      cap = Math.min(cap, 0.3);
      hits.push("terms");
    }
  }

  const avoided = [...FILLER, ...ctx.phrasesAvoided.map((p) => p.toLowerCase())].filter(
    (p) => p && lowerBody.includes(p),
  );
  if (avoided.length) {
    flags.push(`Uses “${avoided[0]}”, which doesn't sound like you.`);
    cap = Math.min(cap, 0.6);
    hits.push("filler");
  }

  return { flags, confidenceCap: cap, hits };
}
