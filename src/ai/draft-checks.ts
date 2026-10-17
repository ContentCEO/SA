/**
 * Code-level spot checks on every draft. The prompt tells the model not to
 * invent prices, dates or promises; these catch it when it does anyway. They
 * never rewrite the draft — they flag it for the owner and lower confidence.
 */
import { withoutGaps } from "./gaps";
import { allNumbers, moneyMentions } from "./money-words";
import { localDay } from "./prompts/draft.v6";
import { newWhenTokens, normalizeWhen, whenTokens } from "./when-words";

export { normalizeWhen } from "./when-words";

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

/*
 * Days, dates, times and loose timing ("today", "ASAP", "within the hour", "before
 * Thanksgiving", "three weeks out") live in when-words.ts as whole-word tokens (Check 20 P1,
 * Check 23 P3 + P4). Each is a commitment when nobody in the conversation said it.
 */

/** Every amount named as money, however it's written (review A1; see money-words.ts). */
function money(text: string): number[] {
  return moneyMentions(text).map((m) => m.amount);
}
const strongMoney = (text: string) =>
  moneyMentions(text)
    .filter((m) => m.strong)
    .map((m) => m.amount);
/** "10%", "12.5 %". */
const PCT = /\b\d+(?:\.\d+)?\s?%/g;

/**
 * Soft promises and admissions (review A3): things an owner has to stand behind that aren't
 * a guarantee in so many words. An admission of fault by email is hard to take back.
 */
const SOFT_PROMISES: [string, RegExp][] = [
  ["take care of everything", /\btake care of (it all|everything|all of it|the whole thing)\b/i],
  ["make it right", /\bmake (it|this|things|that) right\b/i],
  ["that's on us", /\b(that's|that is|it's|it is|this is|this one's) on (us|me)\b/i],
  ["our mistake", /\b(our|my) (mistake|fault|bad|error|screw[- ]?up)\b/i],
  ["won't happen again", /\b(won't|will not|never) happen again\b/i],
  [
    "no charge",
    /\b(no charge|free of charge|at no (extra |additional )?(cost|charge)|won't charge|will not charge|on the house)\b/i,
  ],
  [
    "it will pass inspection",
    /\b(will|it'll|should|is going to|gonna) pass (the |your )?inspection\b/i,
  ],
  ["definitely", /\bdefinitely\b/i],
  ["licensed and insured", /\b(fully )?licensed and insured\b/i],
];

/** Words that make a commitment the owner has to stand behind. */
const COMMITMENT =
  /\b(guarantee[sd]?|guaranteeing|warrant(?:y|ies|ied)|promise[sd]?|promising)\b/gi;

function lowerWords(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ");
}

export type CheckContext = {
  /** Everything the draft is allowed to draw facts from: the conversation and the business profile. */
  sourceText: string;
  /**
   * Check 20 P1: where a day, date or time may come from — the conversation (both sides),
   * seasonal notes and their end dates, and the owner's own instruction. Never the hours,
   * lead time or policies (a shop open "Monday to Friday" can't excuse every "Friday").
   * Left out, `sourceText` is used, as before.
   */
  whenSourceText?: string;
  /**
   * Check 23 P3: the business hours. Their times count ("7am"); a day named only in the
   * hours counts only when `allowHours` (the "Add my availability" tweak, or the customer
   * asked when the owner is open).
   */
  hoursText?: string | null;
  allowHours?: boolean;
  /** Check 23 P4: the owner's lead time; only its "two weeks out" wording counts. */
  leadTimeText?: string | null;
  /**
   * Check 23 P4: the customer's emails with when they were written, so a "tomorrow" read from
   * a three-day-old email is caught. Needs `now`; days are the owner's (`timeZone`).
   */
  customerMessages?: { text: string; sentAt: Date }[];
  now?: Date;
  timeZone?: string | null;
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
  /**
   * What the owner said themselves (review A4): their price list and profile, what they
   * wrote this customer, a clean earlier draft. When given, an amount the draft repeats
   * that only the CUSTOMER named ("we can match the $3,200") is flagged. Left out, every
   * amount in `sourceText` is allowed, as before.
   */
  ownerSourceText?: string;
  /**
   * The owner's own instruction for this draft ("tell her Thursday works, 450"): every number
   * in it is an amount the owner gave (review A5), even without a "$".
   */
  ownerInstruction?: string | null;
};

/** What kind of problem each flag is, so the caller can decide to regenerate. */
export type CheckHit =
  | "money"
  | "when"
  | "commitment"
  | "never_promise"
  | "never_say"
  | "filler"
  | "terms"
  /** Repeats an amount only the customer named (review A4): flagged, never rewritten. */
  | "customer_amount"
  /** A soft promise or an admission (review A3). */
  | "soft_promise";
export type CheckResult = { flags: string[]; confidenceCap: number; hits: CheckHit[] };

/**
 * Hits worth one fresh attempt before flagging (plan #23, #43): an invented price
 * or date, something the owner explicitly banned, or payment terms they never set (A4).
 */
export const REGENERATE_ON: CheckHit[] = ["money", "when", "never_promise", "never_say", "terms"];

/** "50%", "12.5 %". */
const PERCENT = PCT;
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

/** A never-promise item about same-day work, and the draft words that promise it (Check 23 P4). */
const SAME_DAY_ITEM = /\bsame[- ]?day\b/i;
const SAME_DAY_WHEN = /\b(today|tonight|within the hour|within an hour|before the day is out)\b/;

/**
 * Check 23 P4: the draft says "today", "tonight" or "tomorrow" and the only place that word
 * came from is a customer email written on an earlier day (in the owner's time zone).
 */
function staleRelativeDay(body: string, ctx: CheckContext): string | null {
  if (!ctx.customerMessages?.length || !ctx.now) return null;
  const today = localDay(ctx.now, ctx.timeZone);
  const inBody = new Set(whenTokens(body).map((t) => t.key));
  for (const [word, key] of [
    ["tomorrow", "r:tomorrow"],
    ["tonight", "r:tonight"],
    ["today", "l:today"],
  ] as const) {
    if (!inBody.has(key)) continue;
    const has = (t: string | null | undefined) => whenTokens(t ?? "").some((x) => x.key === key);
    if (has(ctx.ownerInstruction)) continue;
    const from = ctx.customerMessages.filter((m) => has(m.text));
    if (!from.length || from.some((m) => localDay(m.sentAt, ctx.timeZone) === today)) continue;
    const latest = from.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
    const weekday = localDay(latest.sentAt, ctx.timeZone).split(",")[0];
    return `Says “${word}”, but they wrote that on ${weekday}. Check the day.`;
  }
  return null;
}

export function checkDraft(draftBody: string, ctx: CheckContext): CheckResult {
  // Placeholders ({{price}}…) are gaps for the owner, not facts — check the words around them.
  const body = withoutGaps(draftBody);
  const flags: string[] = [];
  const hits: CheckHit[] = [];
  let cap = 1;
  const lowerBody = body.toLowerCase();
  const source = ctx.sourceText.toLowerCase();

  // Prices that appear nowhere in the conversation or the profile were made up. A bare number
  // ("is 1500") is only money when nothing else explains it, so it may also match any number
  // the sources wrote ("100 amp" → "your 100"). The owner's own instruction counts in full.
  const ownerText = ctx.ownerSourceText ?? ctx.sourceText;
  const instructionNumbers = new Set(allNumbers(ctx.ownerInstruction));
  const known = new Set([...money(ctx.sourceText), ...money(ownerText), ...instructionNumbers]);
  const anyNumberInSource = new Set([
    ...allNumbers(ctx.sourceText),
    ...allNumbers(ownerText),
    ...instructionNumbers,
  ]);
  const ownerKnown = new Set([...money(ownerText), ...instructionNumbers]);
  const ownerAnyNumber = new Set([...allNumbers(ownerText), ...instructionNumbers]);
  const strong = new Set(strongMoney(body));
  const bodyAmounts = [...new Set(money(body))];
  const invented = bodyAmounts.filter((a) =>
    strong.has(a) ? !known.has(a) : !known.has(a) && !anyNumberInSource.has(a),
  );
  if (invented.length) {
    flags.push(
      `Mentions ${invented.map((a) => `$${a.toLocaleString("en-US")}`).join(", ")} — that price isn't in the email or your profile. Check it.`,
    );
    cap = Math.min(cap, 0.3);
    hits.push("money");
  }
  // An amount only the customer named isn't the owner's price (review A4): "we can match the
  // $3,200" repeats a competitor's quote. Flagged for a look, never rewritten.
  if (ctx.ownerSourceText !== undefined && !ctx.checkTerms) {
    const theirs = bodyAmounts.filter(
      (a) =>
        !invented.includes(a) && !ownerKnown.has(a) && !(!strong.has(a) && ownerAnyNumber.has(a)),
    );
    if (theirs.length) {
      flags.push(
        `Repeats ${theirs.map((a) => `$${a.toLocaleString("en-US")}`).join(", ")}, an amount the customer gave, not you. Make sure that's your number.`,
      );
      cap = Math.min(cap, 0.5);
      hits.push("customer_amount");
    }
  }
  // A percentage off or extra the owner never wrote ("I'll knock 10% off") changes the price.
  // Deposit and review notes have their own, stricter terms check below.
  if (!ctx.checkTerms) {
    const ownerPct = new Set([...ownerText.matchAll(PCT)].map((m) => m[0].replace(/\s+/g, "")));
    const newPct = [
      ...new Set([...body.matchAll(PCT)].map((m) => m[0].replace(/\s+/g, ""))),
    ].filter((p) => !ownerPct.has(p));
    if (newPct.length) {
      flags.push(`Mentions “${newPct.join("”, “")}” — that isn't in anything you wrote. Check it.`);
      cap = Math.min(cap, 0.3);
      if (!hits.includes("money")) hits.push("money");
    }
  }

  // Days, dates and times nobody in the conversation brought up are commitments (Check 20 P1,
  // Check 23 P3): whole words, both sides normalised, never a substring of the hours.
  const newWhen = [
    ...new Set(
      newWhenTokens(body, {
        text: ctx.whenSourceText ?? ctx.sourceText,
        hours: ctx.hoursText,
        allowHours: ctx.allowHours,
        leadTime: ctx.leadTimeText,
      }).map((t) => t.label),
    ),
  ];
  if (newWhen.length) {
    flags.push(`Mentions “${newWhen.join("”, “")}” — make sure you can commit to that.`);
    cap = Math.min(cap, 0.5);
    hits.push("when");
  }
  // "Tomorrow" read from an email written days ago (Check 23 P4).
  const stale = staleRelativeDay(body, ctx);
  if (stale) {
    flags.push(stale);
    cap = Math.min(cap, 0.5);
    if (!hits.includes("when")) hits.push("when");
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

  // Soft promises and admissions the owner never wrote themselves (review A3). The customer
  // asking "will it pass inspection?" doesn't make it the owner's promise.
  const soft = SOFT_PROMISES.filter(
    ([, re]) => re.test(body) && !re.test(ctx.ownerSourceText ?? ctx.sourceText),
  ).map(([label]) => label);
  if (soft.length) {
    flags.push(`Says “${soft.join("”, “")}” — make sure you stand behind that.`);
    cap = Math.min(cap, 0.5);
    hits.push("soft_promise");
  }

  // Never-promise list: flag when the key words of an item all show up in the draft.
  for (const item of ctx.doNotPromise) {
    const words = lowerWords(item)
      .split(" ")
      .filter((w) => w.length > 3);
    const sameDayPromise = SAME_DAY_ITEM.test(item) && SAME_DAY_WHEN.test(normalizeWhen(body));
    if ((words.length && words.every((w) => lowerWords(body).includes(w))) || sameDayPromise) {
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
