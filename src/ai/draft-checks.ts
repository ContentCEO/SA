/**
 * Code-level spot checks on every draft. The prompt tells the model not to
 * invent prices, dates or promises; these catch it when it does anyway. They
 * never rewrite the draft — they flag it for the owner and lower confidence.
 */
import { languageMismatchFlag, type ReplyLanguage } from "./language";
import type { Licenses } from "@/config/licenses";
import { MA_DEPOSIT_DRAFT_FLAG } from "@/config/ma-rules";
import { overMaDepositCap } from "@/server/deposit-rules";
import { blanks, withoutGaps } from "./gaps";
import { allNumbers, moneyMentions, vagueMoney } from "./money-words";
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
  // Check 23 P13: the everyday variants. "Sorry for the delay" stays off: sometimes the owner
  // really was late.
  "thanks for reaching out",
  "thanks so much for reaching out",
  "i hope you're doing well",
  "i hope you are doing well",
  "hope all is well",
  "don't hesitate",
  "do not hesitate",
  "i apologize for any inconvenience",
  "we apologize for any inconvenience",
  "at your earliest convenience",
  "please be advised",
  "rest assured",
  "valued customer",
];

/**
 * A first reply to a new lead may open with a plain "Thanks for reaching out" (draft.v7's
 * first contact, Davi 2026-10-16), so these two aren't filler there.
 */
const FIRST_REPLY_OPENERS = new Set(["thanks for reaching out", "thanks so much for reaching out"]);

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
  // Check 20 P11: "for free" and friends ("feel free" and "free estimate" aren't these).
  [
    "for free",
    /\b(?:for free|free of cost|won't cost you|will not cost you|we'll cover (?:it|the cost)|we will cover (?:it|the cost))\b/i,
  ],
  // "Licensed and insured" is a credential claim now (Check 38 P6, below): it passes once the
  // owner saved a license and an insurance company.
  // Check 23 P2 + Check 36 P7: claims an owner has to stand behind.
  [
    "no permit needed",
    /\b(?:no|don't|do not|doesn't|does not|won't|will not)(?: even)? (?:need|needs|require|requires)(?: a| any)? permits?\b|\bno permits? (?:needed|required)\b|\bskip (?:the )?(?:permit|inspection)\b|\bwithout (?:a )?permit\b/i,
  ],
  ["up to code", /\b(?:up to|meets|passes|to) code\b|\bcode[- ]compliant\b/i],
  [
    "waived fee",
    /\bwaive[sd]?\b|\bwaiving\b|\bknock (?:it )?off\b|\bwon't charge (?:you )?(?:for|the)\b/i,
  ],
  [
    "price match",
    /\b(?:match|beat) (?:their|that|the|his|her|your|any) (?:price|quote|number|bid)\b|\bprice[- ]match\b/i,
  ],
  ["fit you in", /\b(?:squeeze|fit|sneak) (?:you|it|them) in\b/i],
  // Check 38 P7: agreeing to cover a callback or an overage in passing.
  [
    "that's covered",
    /\b(?:that's|that is|it's|it is|this is|that'll be|this'll be) (?:all )?covered\b(?! (?:with|in|by)\b)|\bcovered under (?:the |our |your )?(?:warranty|guarantee|labor|workmanship)\b/i,
  ],
  ["fix it for free", /\b(?:fix|repair|replace|redo) (?:it|that|this|them) (?:for )?free\b/i],
  [
    "add it to the bill",
    /\b(?:add|put|tack|throw) (?:it|that|this|the difference|the extra|the overage)(?: on)? (?:on|onto|to) (?:the |your )?(?:final )?(?:bill|invoice|price|tab|total)\b/i,
  ],
  [
    "that's fine",
    /\b(?:that's|that is) (?:fine|ok|okay|no problem)\b[,;:]?\s*(?:\$\s?\d|\d[\d,]*\s?(?:dollars|bucks)\b|(?:going |being |a (?:bit |little )?)?over\b)/i,
  ],
  [
    "no extra charge",
    /\bno (?:extra|additional) (?:charge|cost|fee)s?\b|\bwon't cost (?:you )?(?:anything )?extra\b/i,
  ],
  // Check 37 P5: rebates belong to the utility; a draft can't promise they'll pay.
  [
    "a rebate or utility will pay",
    /\b(?:eversource|national grid|unitil|mass ?save|the utility|your utility|rebates?|incentives?)\b.{0,50}\b(?:covers?|cover (?:the|all|most)|pays? for|will pay|gives? (?:you )?back|reimburses?|free|for nothing|no cost|won't cost)\b|\byou(?:'ll| will)(?: definitely| likely)? (?:get|qualify for|be eligible for) (?:a |the )?(?:rebate|incentive)\b/i,
  ],
];

/**
 * Check 48 P1: a draft that says a person wrote it with no help ("this is Mike himself", "no
 * bots here", "I answer every email myself"). Anthropic's usage policy forbids a bot claiming
 * to be human; the owner may say it if it's true, so it's a flag, never rewritten.
 */
/** Check 43 P1: the words a "real person" claim has to sit next to ("a real person will call you" is true and passes). */
const BOT_WORDS =
  "(bot|bots|robot|robots|ai|a\\.i\\.|assistant|automated|automation|chatbot|computer|machine)";
const HUMAN_CLAIMS: RegExp[] = [
  /\b(this is|it's|it is|i'm|i am) [a-z][a-z'-]* (himself|herself|themself|themselves|myself)\b/i,
  /\bno bots?\b/i,
  /\bnot (a |an )?(bot|robot|ai|machine|computer)\b/i,
  // Check 43 P1: "real person" only as a claim about who is writing, or near bot / AI words.
  /\b(this is|it's|it is|i'm|i am|you're talking to|you are talking to|talking to|you've got|you have|from) (a |an )?real (person|human)\b/i,
  new RegExp(
    `\\breal (person|human)\\b.{0,60}\\b${BOT_WORDS}\\b|\\b${BOT_WORDS}\\b.{0,60}\\breal (person|human)\\b`,
    "i",
  ),
  /\b(just me|only me|it's me|it is me|me here)\b.{0,30}\breal (person|human)\b/i,
  /\bi (answer|write|read|reply to|handle) (every|each|all (of )?(my|the|your)?) ?(emails?|messages?|repl(y|ies))( \w+)? myself\b/i,
  /\bi (write|type|wrote|typed|answer|answered) (all|every one|each one|these|this|every single one)( of (these|them|my emails|my replies))? myself\b/i,
  /\bnobody else (writes|answers|reads|replies)\b/i,
  /\bnot automated\b/i,
  /\bno (robots|ai|a\.i\.|assistant)\b/i,
  /\bnot an? (a\.i\.|automated (system|reply|response))\b/i,
  // Check 43 P1: Spanish and Portuguese.
  /\bno (soy|es) un (robot|bot)\b/i,
  /(?<![\p{L}])(una )?persona real(?![\p{L}])/iu,
  /(?<![\p{L}])n[aã]o sou um rob[oô](?![\p{L}])/iu,
  /(?<![\p{L}])(uma )?pessoa real(?![\p{L}])/iu,
];
export const HUMAN_CLAIM_FLAG =
  "Says a person wrote this without help. Check it's true before sending.";

/** The draft says a person wrote it with no help (Check 48 P1). */
export function claimsHuman(body: string): boolean {
  return HUMAN_CLAIMS.some((re) => re.test(body));
}

/** Words that make a commitment the owner has to stand behind. */
const COMMITMENT =
  /\b(guarantee[sd]?|guaranteeing|warrant(?:y|ies|ied)|promise[sd]?|promising)\b/gi;

const normalizeSpace = (t: string) => t.toLowerCase().replace(/[\s-]+/g, " ");

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
  /**
   * Check 38 P6: the owner's saved registration and license numbers. A number the draft gives
   * that isn't here (or in what the owner wrote) is flagged, and so is a claim of being
   * registered, licensed, lead-safe certified or insured with nothing saved to back it.
   */
  licenses?: Licenses | null;
  /**
   * Check 23 P6: names the draft may use without them being in `sourceText` — the customer's
   * own name from the email's From line, the owner's.
   */
  knownNames?: string[];
  /** A first reply to a new lead (draft.v7): "Thanks for reaching out" is its warm opener. */
  firstContact?: boolean;
  /** Check 23 P14: the owner's price list, to hold its wording ("from") and its job. */
  priceList?: string | null;
  /** Check 38 P2: the owner's two-letter state; "MA" turns on the one-third deposit check. */
  state?: string | null;
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
  /** Check 43 P8: the language the reply should be in (decided in code). Left out: no check. */
  replyLanguage?: ReplyLanguage;
  /** Check 12 P7: an invoice reminder — an easy out ("no worries if not") is flagged. */
  invoiceReminder?: boolean;
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
  | "soft_promise"
  /** Check 36 P7 / 38 P6: a license or registration number the owner never saved. */
  | "license"
  /** Check 38 P6: "we're registered / licensed / lead-safe certified / insured", unbacked. */
  | "credential"
  /** Check 40 P1: covering a deductible or handling the homeowner's insurance claim. */
  | "insurance"
  /** Check 41 P1: lead-paint and "safe for kids and pets" claims. */
  | "safety"
  /** Check 39 P4: a rebate, tax-credit or refrigerant rule the owner never wrote. Flag only. */
  | "rule_claim"
  /**
   * Check 23 P5: an ordinary reply names payment terms the owner never set ("net 30", "Venmo
   * works", "half down"). Its own hit, apart from the deposit / review "terms" check, so it
   * flags without a rewrite (it is not in REGENERATE_ON).
   */
  | "payment_terms"
  /** Check 12 P7: an invoice reminder offers an easy out. Flag only. */
  | "easy_out"
  /** Check 38 P2: asks a Massachusetts customer for more than a one-third deposit. Flag only. */
  | "deposit_cap"
  /** Check 23 P6: a phone number, link, email address or name nobody gave. */
  | "contact"
  /** Check 23 P7: a "[name]"-style blank, so the card never reads Ready. Flag only. */
  | "blank"
  /**
   * Check 23 P14: a listed price without its "from", or used for another job. Flag only — it
   * joins REGENERATE_ON only if Davi says so (that's why it isn't the "money" hit).
   */
  | "price_list"
  /** Check 48 P1: says a person wrote it with no help. Flag only, never regenerated. */
  | "human_claim"
  /** Check 43 P8: the reply isn't in the language chosen for it. Flag only. */
  | "language";
export type CheckResult = { flags: string[]; confidenceCap: number; hits: CheckHit[] };

/**
 * Hits worth one fresh attempt before flagging (plan #23, #43): an invented price
 * or date, something the owner explicitly banned, or payment terms they never set (A4).
 */
export const REGENERATE_ON: CheckHit[] = [
  "money",
  "when",
  "never_promise",
  "never_say",
  "terms",
  // Check 36 P7: a made-up license number gets one fresh attempt.
  "license",
  // Check 40 P1: an insurance-job promise gets one fresh attempt.
  "insurance",
  // Check 41 P1: a safety or lead claim gets one fresh attempt.
  "safety",
  // Check 23 P6: a made-up phone number, link or name gets one fresh attempt.
  "contact",
];

/** Check 23 P6: a US phone number (the pattern voice.ts scrubs), and an email address. */
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const phoneDigits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
/**
 * Check 23 P6: a name the draft introduces — "my guy Pete", "our tech Luis", "the Hendersons",
 * "for Marie last week". Narrow on purpose: greetings, sign-offs, towns, streets and brands
 * ("for Mass Save", "for Eversource customers") aren't caught here.
 */
const NAMED =
  /\b(?:[Mm]y guys?|[Oo]ur (?:tech|guy|plumber|electrician|crew lead|foreman|installer|helper|painter|roofer|carpenter))\s+([A-Z][a-z]{1,20})\b|\b[Tt]he ([A-Z][a-z]{2,20})s\b|\bfor ([A-Z][a-z]{1,20})\b(?=[,.!?]|\s+(?:last|on|in|over|down|up|a|the|and|at|back|just|too)\b)/g;
/** Capitalised words after "for" / "the …s" that aren't people. */
const NOT_A_NAME = new Set([
  ...["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  ...["january", "february", "march", "april", "may", "june", "july", "august"],
  ...["september", "october", "november", "december", "christmas", "thanksgiving", "easter"],
  ...["god", "sure", "now", "free", "you", "your", "the", "a", "an", "us", "me", "it", "this"],
]);

const PEOPLE_AND_PETS =
  "kids?|children|child|baby|babies|newborns?|toddlers?|pets?|dogs?|cats?|family|people|humans?";

/**
 * Check 41 P1: health and safety claims. On pre-1978 homes the federal lead rule bans open-flame
 * burning and high-speed sanding without a HEPA shroud, and "safe", "harmless" or "non-toxic to
 * people and pets" is the sentence a lawyer quotes back. Each counts only when the owner never
 * wrote it; the customer asking "is it safe for the baby?" doesn't excuse the draft saying so.
 */
const SAFETY_CLAIMS: [string, RegExp][] = [
  [
    "no lead worries",
    /\b(?:no need to worry about|don't worry about|do not worry about|nothing to worry about|no worries about) (?:the |any )?lead\b|\blead[- ]free\b|\bno lead\b/i,
  ],
  [
    "safe for people or pets",
    new RegExp(
      `\\b(?:completely |totally |100% |perfectly |100 percent )?(?:safe|harmless|non-?toxic)\\b[^.!?]{0,40}\\b(?:${PEOPLE_AND_PETS})\\b|\\b(?:${PEOPLE_AND_PETS})\\b[^.!?]{0,40}\\b(?:safe|harmless|non-?toxic)\\b`,
      "i",
    ),
  ],
  ["pet and kid safe", /\b(?:pet|kid|child|family)[- ](?:safe|friendly)\b/i],
];
/**
 * Check 39 P4: program and rule words whose facts change every year (Mass Save amounts each
 * January, the federal heat pump credit, EPA refrigerant rules). "Credit card" isn't one.
 */
const RULE_WORDS =
  /\b(?:rebates?|incentives?|tax credits?|credits?(?! cards?)|heat loan|mass ?save|0% (?:loan|financing)|qualif(?:y|ies)|eligible|epa|r-?22|r-?410a|r-?454b|r-?32|freon|refrigerants?|banned|phased out|phase-?out|legal|illegal|no longer (?:made|allowed)|code requires|required by code)\b/gi;

/** "Tax credits" → "credit", "R-410A" → "r410a": the word to look for in the owner's text. */
const ruleKey = (w: string) =>
  w
    .toLowerCase()
    .replace(/^tax /, "")
    .replace(/^(r)-?(\d)/, "$1$2")
    .replace(/-/g, " ")
    .replace(/(rebate|incentive|credit|refrigerant)s$/, "$1")
    .replace(/^qualifies$/, "qualify");

/**
 * Check 39 P4: a sentence states a rule when it names a program or rule word the owner never
 * wrote (their profile, price list, notes, instruction or own emails).
 */
function ruleClaim(body: string, ownerText: string): boolean {
  const owner = ` ${ownerText
    .toLowerCase()
    .replace(/\b(r)-?(\d)/g, "$1$2")
    .replace(/[^a-z0-9%]+/g, " ")} `;
  return body.split(/(?<=[.!?])\s+|\n+/).some((sentence) =>
    [...sentence.matchAll(RULE_WORDS)].some((m) => {
      const key = ruleKey(m[0]).replace(/[^a-z0-9% ]+/g, " ");
      return (
        !new RegExp(`\\s${key.replace(/[%]/g, "\\$&")}(?:s|es|ies)?\\s`).test(owner) &&
        !(key === "qualify" && /\squalifies\s/.test(owner))
      );
    }),
  );
}

/** Ways of taking old paint off that the lead rule bans on older homes (Check 41 P1). */
const UNSAFE_PAINT_REMOVAL =
  /\b(?:power[- ]?sand\w*|sandblast\w*|torch\w*|burn (?:it |the paint |the old paint )?off|heat gun)\b/i;

/**
 * Check 41 P1: the conversation shows a home built before 1978 — a year from 1800 to 1977 near
 * "built", "house", "home" or "colonial", or "old house", "pre-1978", "victorian".
 */
export function olderHome(text: string): boolean {
  const t = text ?? "";
  const year = "(?:18\\d\\d|19[0-6]\\d|197[0-7])";
  const word = "(?:built|house|home|colonial|cape|farmhouse|bungalow)";
  return (
    new RegExp(
      `\\b${word}\\b[^.!?\\n]{0,40}\\b${year}\\b|\\b${year}\\b[^.!?\\n]{0,40}\\b${word}\\b`,
      "i",
    ).test(t) || /\bold house\b|\bpre-?1978\b|\bvictorian\b/i.test(t)
  );
}

/**
 * Check 40 P1: insurance-job promises the owner may not be allowed to make. Waiving or eating a
 * deductible is illegal for contractors in some states, and in Massachusetts only a licensed
 * public adjuster may adjust a claim for the homeowner. Each counts only when the owner never
 * wrote it themselves.
 */
const INSURANCE_PROMISES: [string, RegExp][] = [
  [
    "the deductible",
    /\b(?:cover|waive|absorb|eat|take care of|pay(?: for)?|pick up|rebate|handle|knock off)\s+(?:the |your |that |this )?(?:\$[\d,.]+k?\s+)?deductibles?\b/i,
  ],
  [
    "insurance will pay",
    /\b(?:insurance|your insurer|the insurer|insurance company)\s+(?:will|should|is going to|'ll|is gonna)\s+(?:definitely\s+)?(?:cover|pay)\b/i,
  ],
  [
    "dealing with the adjuster",
    /\b(?:we'll|we will|we can|i'll|i will|i can|we)\s+(?:negotiate|fight|deal|argue|battle)\s+with\s+(?:your|the)\s+(?:adjuster|insurance|insurer)/i,
  ],
  [
    "handling the claim",
    /\b(?:we|we'll|we will|we can|i|i'll|i will|i can)\s+(?:handle|take care of|manage|file|run)\s+(?:the|your)\s+(?:whole\s+|entire\s+)?(?:insurance\s+)?claim\b/i,
  ],
  ["assignment of benefits", /\bassignment of benefits\b/i],
  ["sign today", /\bsign (?:it |the [a-z]+ |our [a-z]+ (?:[a-z]+ )?)?today\b/i],
  ["free roof", /\bfree roof\b/i],
  ["no cost to you", /\bno cost to you\b|\b(?:nothing|anything) out of pocket\b/i],
];

/**
 * Check 36 P7 + 38 P6: a license or registration number — after HIC, CSL, CS-, MP-, JP-, MGF,
 * LR-, "license", "lic.", "registration", "reg #" — with at least three digits.
 */
const LICENSE_NUMBER =
  /\b(?:hic|csl|cs|mp|jp|mgf|lr|license|licence|lic|registration|reg)\b\.?(?:[\s,:#-]|\bnumber\b|\bno\b\.?|\bnum\b|\bis\b)*([a-z]{0,4}-?\s?\d{3,}[a-z0-9-]*)/gi;

/** The digit runs (3+) a text holds, to compare license numbers however they're written. */
const digitRuns = (t: string) => new Set([...t.matchAll(/\d{3,}/g)].map((m) => m[0]));

/** Check 38 P6: credential claims, each with the saved field that backs it. */
const CREDENTIALS: [string, RegExp, (l: Licenses) => boolean][] = [
  [
    "registered",
    /\b(?:hic|home improvement)[- ](?:registered|registration)\b|\bregistered (?:hic|home improvement contractor|with the state|in the state|contractor)\b|\b(?:we're|we are|i'm|i am)(?: fully)? (?:state[- ])?registered\b|\bbonded (?:with|in) the state\b/i,
    (l) => !!l.hic_number?.trim(),
  ],
  [
    "licensed",
    /\b(?:i|we) (?:hold|have) (?:a|an|the|my|our) (?:csl|construction supervisor|master|journeyman)|\blicensed (?:master|journeyman|plumber|electrician|contractor|gasfitter|builder)\b|\b(?:we're|we are|i'm|i am)(?: fully)? licensed\b|\blicensed and insured\b/i,
    (l) => !!l.csl_number?.trim(),
  ],
  [
    "lead-safe certified",
    /\blead[- ]safe (?:certified|certification|renovat\w*|licensed?|contractor)\b|\b(?:epa )?rrp[- ]certified\b/i,
    (l) => !!l.lead_safe_license?.trim(),
  ],
  [
    "insured",
    /\b(?:we're|we are|i'm|i am|fully|are) insured\b|\blicensed and insured\b|\bcertificate of insurance\b|\binsurance certificate\b/i,
    (l) => !!l.insurance_carrier?.trim(),
  ],
];

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

/**
 * Check 23 P5: the payment methods for the light check on ordinary replies — METHODS, with cash
 * needing a payment context too ("pay in cash", "cash works"), so "save some cash" stays clean.
 */
const LIGHT_METHODS: [string, RegExp, RegExp][] = METHODS.map(([label, inBody, inTerms]) =>
  label === "cash"
    ? [
        label,
        /\b(?:in|with|by|pay(?:ing)?(?: in| with| by)?|take|accept)\s+cash\b|\bcash (?:is fine|works|only|is ok|is okay)\b/i,
        inTerms,
      ]
    : [label, inBody, inTerms],
);
/** "half down", "a deposit of", "30% up front". */
const LIGHT_DEPOSIT =
  /\bhalf (?:down|up ?front)\b|\b(?:a |the )?deposit of\b|\b\d+\s?% (?:down|up ?front|deposit)\b/gi;
/** "net 30", "due in 15 days", "pay later", "payment plan", "financing". */
const LIGHT_CREDIT =
  /\bnet \d+\b|\bdue in \d+ days\b|\bpay (?:it )?later\b|\bpayment plans?\b|\bfinancing\b/gi;

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

/** Check 23 P14: qualifiers a listed price carries, with the words that count as the same. */
const BEFORE_QUALIFIERS: [RegExp, RegExp][] = [
  [/\bfrom\b/i, /\b(?:from|starting|starts)\b/i],
  [/\bstarting at\b/i, /\b(?:from|starting|starts)\b/i],
  [/\bstarts at\b/i, /\b(?:from|starting|starts)\b/i],
  [/\b(?:about|around|roughly)\b/i, /\b(?:about|around|roughly|approximately|ballpark)\b/i],
];
const AFTER_QUALIFIERS: [RegExp, RegExp][] = [
  [/\bplus parts\b|\+\s?parts\b/i, /\bplus parts\b|\+\s?parts\b|\band parts\b|\bparts extra\b/i],
  [/\bper hour\b|\/\s?(?:hr|hour)\b|\ban hour\b/i, /\bper hour\b|\/\s?(?:hr|hour)\b|\ban hour\b/i],
];
const PRICE_ROW_STOP = new Set([
  "from",
  "starting",
  "starts",
  "about",
  "around",
  "plus",
  "parts",
  "installed",
  "each",
  "with",
  "includes",
  "included",
  "only",
]);

export type PriceListRow = {
  amounts: number[];
  /** The qualifier the line gives its first amount, as written ("from", "plus parts"), or null. */
  qualifier: string | null;
  /** The regex a draft's wording must match for that qualifier. */
  qualifierRe: RegExp | null;
  /** Whether the qualifier comes before the amount ("from $1,450") or after ("$95 plus parts"). */
  qualifierBefore: boolean;
  /** Words longer than three letters before the colon or the first amount: the job it's for. */
  keyWords: string[];
};

/** Check 23 P14: one row per price-list line that names an amount. */
export function priceListRows(pricingNotes: string | null | undefined): PriceListRow[] {
  return (pricingNotes ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const amounts = [...new Set(moneyMentions(line).map((m) => m.amount))];
      if (!amounts.length) return [];
      // Where the first price is: a "$" amount, else the first number after the colon.
      const dollar = line.search(/\$\s?\d/);
      const afterColon = line.indexOf(":") + 1;
      const firstAt =
        dollar >= 0 ? dollar : afterColon + Math.max(0, line.slice(afterColon).search(/\d/));
      const colon = line.indexOf(":");
      const head = line.slice(0, colon >= 0 && colon < firstAt ? colon : Math.max(firstAt, 0));
      const keyWords = [
        ...new Set(
          head
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter((w) => w.length > 3 && !PRICE_ROW_STOP.has(w)),
        ),
      ];
      const before = line.slice(colon >= 0 && colon < firstAt ? colon : 0, firstAt);
      const after = line.slice(firstAt);
      const b = BEFORE_QUALIFIERS.find(([q]) => q.test(before));
      const a = b ? undefined : AFTER_QUALIFIERS.find(([q]) => q.test(after));
      const pick = b ?? a;
      return [
        {
          amounts,
          qualifier: pick ? (pick[0].exec(b ? before : after)![0].toLowerCase() ?? null) : null,
          qualifierRe: pick ? pick[1] : null,
          qualifierBefore: !!b,
          keyWords,
        },
      ];
    });
}

/**
 * Check 23 P14: every amount a body writes with digits, with where it is. A bare number counts
 * only when the money finder reads it as money ("a 40 gal tank" is not $40).
 */
function amountsAt(body: string): { amount: number; at: number; end: number }[] {
  const asMoney = new Set(moneyMentions(body).map((m) => m.amount));
  return [
    ...body.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d{2})?\b/g),
  ]
    .map((m) => ({
      dollar: m[1] !== undefined,
      amount: Number((m[1] ?? m[2])!.replace(/,/g, "")),
      at: m.index!,
      end: m.index! + m[0].length,
    }))
    .filter((h) => h.dollar || asMoney.has(h.amount));
}

/** Check 23 P14: a listed price without its qualifier, or used for a different job. */
function priceListFlags(body: string, priceList: string | null | undefined): string[] {
  const rows = priceListRows(priceList);
  if (!rows.length) return [];
  const out: string[] = [];
  for (const hit of amountsAt(body)) {
    const row = rows.find((r) => r.amounts.includes(hit.amount));
    if (!row) continue;
    const money = `$${hit.amount.toLocaleString("en-US")}`;
    if (row.qualifierRe) {
      const near = row.qualifierBefore
        ? body.slice(Math.max(0, hit.at - 40), hit.at)
        : body.slice(hit.end, hit.end + 40);
      if (!row.qualifierRe.test(near))
        out.push(`Gives ${money} without “${row.qualifier}”, as your price list has it. Check it.`);
    }
    if (row.keyWords.length) {
      const start =
        Math.max(...[".", "!", "?", "\n"].map((c) => body.lastIndexOf(c, hit.at - 1))) + 1;
      const ends = [".", "!", "?", "\n"].map((c) => body.indexOf(c, hit.end)).filter((i) => i >= 0);
      const sentence = body
        .slice(start, ends.length ? Math.min(...ends) : body.length)
        .toLowerCase();
      const forThisJob = row.keyWords.some((w) => new RegExp(`\\b${w}(?:s|es)?\\b`).test(sentence));
      if (!forThisJob) out.push(`Uses your ${money} price for something else. Check it.`);
    }
  }
  return [...new Set(out)];
}

const curlyToStraight = (t: string) => t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/**
 * Check 23 P10: a phrase as whole words, any case: escaped, inner spaces matching any run of
 * whitespace (a line break too), and no letter or digit right before or after — so "hun" is
 * not in "hunt", while "no problem!" and "a.s.a.p." still work.
 */
export function phraseRegex(phrase: string): RegExp {
  const escaped = curlyToStraight(phrase.trim())
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Check 41 P2: the draft names a day, date or time (DAYS, TIMES, DATES or a loose "when" like
 * "tomorrow morning"), whoever wrote that day first. A scheduling reply that does is a visit
 * confirmation — on a rain day exactly the one the owner may want to change — so it never goes
 * in "Send together". Gaps are left out first. Pure.
 */
export function namesAVisitTime(body: string): boolean {
  return whenTokens(withoutGaps(body)).length > 0;
}

export function checkDraft(draftBody: string, ctx: CheckContext): CheckResult {
  // Placeholders ({{price}}…) are gaps for the owner, not facts — check the words around them.
  const body = withoutGaps(draftBody);
  const flags: string[] = [];
  const hits: CheckHit[] = [];
  let cap = 1;

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
  // A license number is not a price (Check 38 P6): the money finder never sees it.
  const licenseHits = [...body.matchAll(LICENSE_NUMBER)];
  const moneyBody = body.replace(LICENSE_NUMBER, " ");
  const strong = new Set(strongMoney(moneyBody));
  const bodyAmounts = [...new Set(money(moneyBody))];
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
  // Money named without a number (Check 23 P1): "low four figures", "a few bucks".
  const vague = vagueMoney(body).filter(
    (v) => !normalizeSpace(ownerText).includes(normalizeSpace(v)),
  );
  if (vague.length) {
    flags.push(`Gives a rough price (“${vague[0]}”). Check you want to name a number.`);
    cap = Math.min(cap, 0.3);
    if (!hits.includes("money")) hits.push("money");
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

  // Guarantee / warranty / promise language the owner never used (Check 23 P2): a customer's
  // "Is that under warranty?" never makes it the owner's promise.
  const ownerLower = ownerText.toLowerCase();
  const commitments = [
    ...new Set([...body.matchAll(COMMITMENT)].map((m) => m[0].toLowerCase())),
  ].filter((w) => !ownerLower.includes(w));
  if (commitments.length) {
    flags.push(`Says “${commitments.join("”, “")}” — make sure you stand behind that.`);
    cap = Math.min(cap, 0.4);
    hits.push("commitment");
  }

  // Soft promises and admissions the owner never wrote themselves (review A3). The customer
  // asking "will it pass inspection?" doesn't make it the owner's promise.
  // An owner who offers free estimates may have the draft say "estimates are for free".
  const softBody = /\bfree (?:estimates?|quotes?)\b/i.test(ownerText)
    ? body.replace(/\b(estimates?|quotes?)\s+(?:are\s+|is\s+)?(?:always\s+)?for free\b/gi, "$1")
    : body;
  const soft = SOFT_PROMISES.filter(
    ([, re]) => re.test(softBody) && !re.test(ctx.ownerSourceText ?? ctx.sourceText),
  ).map(([label]) => label);
  if (soft.length) {
    flags.push(`Says “${soft.join("”, “")}” — make sure you stand behind that.`);
    cap = Math.min(cap, 0.5);
    hits.push("soft_promise");
  }

  // License and registration numbers the owner never saved or wrote (Check 36 P7, 38 P6).
  const ownerRuns = digitRuns([ownerText, ctx.ownerInstruction ?? ""].join("\n"));
  const unknownNumbers = licenseHits.filter((m) => {
    const runs = [...digitRuns(m[1]!)];
    return !runs.length || runs.some((r) => !ownerRuns.has(r));
  });
  if (unknownNumbers.length) {
    flags.push("Mentions a license or registration number you haven't saved. Check it.");
    cap = Math.min(cap, 0.3);
    hits.push("license");
  }
  // "We're registered / licensed / lead-safe certified / insured" with nothing saved to back it
  // (Check 38 P6). The owner's own words back it too.
  const saved = ctx.licenses ?? {};
  const ownerHasLicenseNumber = [...ownerText.matchAll(LICENSE_NUMBER)].length > 0;
  const unbacked = CREDENTIALS.filter(
    ([label, re, backed]) =>
      re.test(body) &&
      !backed(saved) &&
      !re.test(ownerText) &&
      !(label === "licensed" && ownerHasLicenseNumber),
  ).map(([label]) => label);
  if (unbacked.length) {
    flags.push(`Says you're ${unbacked.join(" and ")}. Add it in Settings or take it out.`);
    cap = Math.min(cap, 0.5);
    hits.push("credential");
  }

  // Insurance-job promises (Check 40 P1): a flag, and one fresh attempt first.
  if (INSURANCE_PROMISES.some(([, re]) => re.test(body) && !re.test(ownerText))) {
    flags.push(
      "Talks about the deductible or the insurance claim in a way you may not be allowed to promise. Check it.",
    );
    cap = Math.min(cap, 0.2);
    hits.push("insurance");
  }

  // Lead-paint and "safe for kids and pets" claims (Check 41 P1).
  const safety = [
    ...SAFETY_CLAIMS,
    ...(olderHome(ctx.sourceText)
      ? ([["dry-scraping or torching old paint", UNSAFE_PAINT_REMOVAL]] as [string, RegExp][])
      : []),
  ]
    .filter(([, re]) => re.test(body) && !re.test(ownerText))
    .map(([label]) => label);
  if (safety.length) {
    flags.push(
      `Says “${safety.join("”, “")}”. Safety and lead claims are yours to make, not the assistant's. Check it before sending.`,
    );
    cap = Math.min(cap, 0.3);
    hits.push("safety");
  }

  // A rebate, tax-credit or refrigerant rule the owner never wrote (Check 39 P4): flag only,
  // never a rewrite or another model call.
  if (ruleClaim(body, [ownerText, ctx.ownerInstruction ?? ""].join("\n"))) {
    flags.push(
      "Says something about a rebate, tax credit or refrigerant rule. Check it's still true before sending.",
    );
    cap = Math.min(cap, 0.5);
    hits.push("rule_claim");
  }

  // The price list's own wording and job (Check 23 P14). A flag for the owner; it is not sent
  // back for a rewrite unless Davi says so.
  const listFlags = priceListFlags(moneyBody, ctx.priceList);
  if (listFlags.length) {
    flags.push(...listFlags.slice(0, 2));
    cap = Math.min(cap, 0.5);
    hits.push("price_list");
  }

  // A "[name]"-style blank (Check 23 P7): the send gate refuses it, so the card must not read
  // Ready. Flag only; the card shows it as a gap to fill in.
  const blank = blanks(draftBody);
  if (blank.length) {
    flags.push(`Has a blank (“${blank[0]!.trim()}”) to fill in.`);
    cap = Math.min(cap, 0.6);
    hits.push("blank");
  }

  // Phone numbers, links, email addresses and names nobody gave (Check 23 P6).
  const contact: string[] = [];
  const sourcePhones = new Set([...ctx.sourceText.matchAll(PHONE)].map((m) => phoneDigits(m[0])));
  const sourceRuns = ctx.sourceText.replace(/\D+/g, " ");
  for (const m of body.matchAll(PHONE)) {
    const digits = phoneDigits(m[0]);
    if (!sourcePhones.has(digits) && !` ${sourceRuns} `.includes(` ${digits} `))
      contact.push(
        `Has the number ${m[0].trim()}, which isn't in your profile or this email. Check it.`,
      );
  }
  const sourceUrls = [...ctx.sourceText.matchAll(URL)].map((m) => m[0]);
  for (const u of new Set([...body.matchAll(URL)].map((m) => m[0]))) {
    const allowed =
      sourceUrls.some((s) => sameUrl(u, s)) ||
      (ctx.review?.url ? sameUrl(u, ctx.review.url) : false);
    // A review request's own link check below says it better.
    if (!allowed && !ctx.review)
      contact.push(
        `Has the link ${u.replace(/[.,!?;:]+$/, "")}, which isn't in your profile or this email. Check it.`,
      );
  }
  const sourceLower = ctx.sourceText.toLowerCase();
  for (const a of new Set([...body.matchAll(EMAIL_ADDRESS)].map((m) => m[0].toLowerCase())))
    if (!sourceLower.includes(a))
      contact.push(`Has the address ${a}, which isn't in your profile or this email. Check it.`);
  const knownNameText = (ctx.knownNames ?? []).join(" ").toLowerCase();
  for (const m of body.matchAll(NAMED)) {
    const name = (m[1] ?? m[2] ?? m[3])!;
    const key = name.toLowerCase();
    if (NOT_A_NAME.has(key)) continue;
    if (
      new RegExp(`\\b${key}`, "i").test(sourceLower) ||
      new RegExp(`\\b${key}`).test(knownNameText)
    )
      continue;
    contact.push(`Mentions “${name}”, who isn't in this email or your profile. Check it.`);
  }
  if (contact.length) {
    flags.push(...[...new Set(contact)].slice(0, 2));
    cap = Math.min(cap, 0.3);
    hits.push("contact");
  }

  // Check 48 P1: never claim no assistant helped. A flag, never regenerated (it may be true of
  // the owner's own words; they decide).
  if (claimsHuman(body)) {
    flags.push(HUMAN_CLAIM_FLAG);
    cap = Math.min(cap, 0.2);
    hits.push("human_claim");
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

  // The owner's never-say list: any listed phrase, anywhere, any case — as whole words (Check
  // 23 P10: "hun" is not in "hunt", "sir" is not in "desire").
  const phraseBody = curlyToStraight(body);
  for (const phrase of ctx.neverSay ?? []) {
    const p = phrase.trim();
    if (p && phraseRegex(p).test(phraseBody)) {
      flags.push(`Says “${phrase.trim()}”, which is on your never-say list.`);
      cap = Math.min(cap, 0.2);
      hits.push("never_say");
    }
  }

  // Check 23 P5: a light payment-terms check on every ordinary reply that carries the owner's
  // terms. A way to pay said the draft's way ("Venmo works", "by Zelle"), deposit wording, or
  // credit terms, when the owner's terms and own emails don't say it. "Let me check" and "card"
  // on its own stay clean. Flag only.
  if (!ctx.checkTerms && ctx.termsSource !== undefined) {
    const terms = ctx.termsSource ?? "";
    const owner = ctx.ownerWrote ?? "";
    const ownerSaid = `${terms}\n${owner}`;
    const found: string[] = [];
    for (const [label, inBody, inTerms] of LIGHT_METHODS)
      if (inBody.test(body) && !inTerms.test(terms) && !inBody.test(owner)) found.push(label);
    for (const m of body.matchAll(LIGHT_DEPOSIT))
      if (!/\bdeposit|\bdown\b|\bup ?front\b|\bhalf\b|%/i.test(ownerSaid)) found.push(m[0].trim());
    for (const m of body.matchAll(LIGHT_CREDIT)) {
      const said = m[0].toLowerCase().replace(/\s+/g, " ");
      const key =
        /^net/.test(said) || /^due in/.test(said) ? said : said.replace(/^pay (it )?/, "");
      if (!ownerSaid.toLowerCase().replace(/\s+/g, " ").includes(key)) found.push(m[0]);
    }
    const unique = [...new Set(found.map((f) => f.toLowerCase()))];
    if (unique.length) {
      flags.push(
        `Mentions “${[...new Set(found)].slice(0, 3).join("”, “")}” — that isn't in your payment terms. Check it.`,
      );
      cap = Math.min(cap, 0.5);
      hits.push("payment_terms");
    }
  }

  // Massachusetts' one-third deposit cap (Check 38 P2): on a deposit note or any draft that
  // states a deposit share. Never rewritten.
  if (overMaDepositCap(ctx.state, body)) {
    flags.push(MA_DEPOSIT_DRAFT_FLAG);
    cap = Math.min(cap, 0.5);
    hits.push("deposit_cap");
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

  const avoided = [
    ...FILLER.filter((p) => !(ctx.firstContact && FIRST_REPLY_OPENERS.has(p))),
    ...ctx.phrasesAvoided.map((p) => p.trim().toLowerCase()),
  ].filter((p) => p && phraseRegex(p).test(phraseBody));
  if (avoided.length) {
    flags.push(`Uses “${avoided[0]}”, which doesn't sound like you.`);
    cap = Math.min(cap, 0.6);
    hits.push("filler");
  }

  // Check 43 P8: a reply in another language than the one chosen (the owner may not read it).
  const wrongLanguage = ctx.replyLanguage ? languageMismatchFlag(body, ctx.replyLanguage) : null;
  if (wrongLanguage) {
    flags.push(wrongLanguage);
    cap = Math.min(cap, 0.5);
    hits.push("language");
  }

  // Check 12 P7: an invoice reminder never tells someone who owes money that skipping it is fine.
  if (ctx.invoiceReminder && EASY_OUT.test(body)) {
    flags.push(EASY_OUT_FLAG);
    cap = Math.min(cap, 0.5);
    hits.push("easy_out");
  }

  return { flags, confidenceCap: cap, hits };
}

const EASY_OUT =
  /\b(no worries|no rush|no pressure|not a good time|isn't a good time|if it's not a good time|gone another way|went another way|go another way|whenever you get (a chance|to it)|totally fine if|that's fine too|if you'd rather not|if you've decided against|feel free to ignore)\b/i;
export const EASY_OUT_FLAG = "Offers an easy out on an unpaid invoice. Take that out.";
