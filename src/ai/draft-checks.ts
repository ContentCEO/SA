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
};

export type CheckResult = { flags: string[]; confidenceCap: number };

export function checkDraft(body: string, ctx: CheckContext): CheckResult {
  const flags: string[] = [];
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
  }

  // Days, dates and times the customer didn't bring up are commitments.
  const whenInBody = [...body.matchAll(DAYS), ...body.matchAll(TIMES), ...body.matchAll(DATES)].map(
    (m) => m[0].toLowerCase(),
  );
  const newWhen = [...new Set(whenInBody)].filter((w) => !source.includes(w));
  if (newWhen.length) {
    flags.push(`Mentions “${newWhen.join("”, “")}” — make sure you can commit to that.`);
    cap = Math.min(cap, 0.5);
  }

  // Never-promise list: flag when the key words of an item all show up in the draft.
  for (const item of ctx.doNotPromise) {
    const words = lowerWords(item)
      .split(" ")
      .filter((w) => w.length > 3);
    if (words.length && words.every((w) => lowerWords(body).includes(w))) {
      flags.push(`Looks like it promises “${item}”, which is on your never-promise list.`);
      cap = Math.min(cap, 0.2);
    }
  }

  const avoided = [...FILLER, ...ctx.phrasesAvoided.map((p) => p.toLowerCase())].filter(
    (p) => p && lowerBody.includes(p),
  );
  if (avoided.length) {
    flags.push(`Uses “${avoided[0]}”, which doesn't sound like you.`);
    cap = Math.min(cap, 0.6);
  }

  return { flags, confidenceCap: cap };
}
