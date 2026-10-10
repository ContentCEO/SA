/**
 * Code-level spot checks on every draft. The prompt tells the model not to
 * invent prices, dates or promises; these catch it when it does anyway. They
 * never rewrite the draft — they flag it for the owner and lower confidence.
 */

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

function money(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) =>
    Number(m[1]!.replace(/,/g, "")),
  );
}

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
};

/** What kind of problem each flag is, so the caller can decide to regenerate. */
export type CheckHit = "money" | "when" | "never_promise" | "never_say" | "filler";
export type CheckResult = { flags: string[]; confidenceCap: number; hits: CheckHit[] };

/** Hits worth one fresh attempt before flagging (the owner explicitly banned these). */
export const REGENERATE_ON: CheckHit[] = ["never_promise", "never_say"];

export function checkDraft(body: string, ctx: CheckContext): CheckResult {
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
