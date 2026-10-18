/**
 * Days, dates and times in a draft, as whole words (Check 20 P1, Check 23 P3 + P4).
 *
 * The draft check used to ask `source.includes("fri")`, so "fridge" excused "Fri", "month"
 * excused "Mon", and an hours line ("Monday to Friday") excused every weekday. Here both
 * sides are normalised the same way ("Fri" → "friday", "8 a.m." → "8am", "Nov 27" →
 * "november 27", "Mon–Fri" → each day) and turned into tokens; the check compares tokens,
 * never substrings. Pure: no database, no model.
 */

export const DAY_NAMES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const MONTHS: Record<string, string> = {
  jan: "january",
  feb: "february",
  mar: "march",
  apr: "april",
  jun: "june",
  jul: "july",
  aug: "august",
  sep: "september",
  sept: "september",
  oct: "october",
  nov: "november",
  dec: "december",
};
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Day abbreviations. "Sat", "Sun" and "Wed" are also everyday words ("I sat down", "the sun",
 * "they wed"), so those count only when capitalised; the rest count in any case.
 */
const DAY_ABBR: [RegExp, string][] = [
  [/(?<!')\b(?:[Mm]on|MON)\b\.?/g, "monday"],
  [/(?<!')\b(?:tue|tues)\b\.?/gi, "tuesday"],
  [/(?<!')\b(?:Wed|WED)\b\.?/g, "wednesday"],
  [/(?<!')\b(?:thu|thur|thurs)\b\.?/gi, "thursday"],
  [/(?<!')\bfri\b\.?/gi, "friday"],
  [/(?<!')\b(?:Sat|SAT)\b\.?/g, "saturday"],
  [/(?<!')\b(?:Sun|SUN)\b\.?/g, "sunday"],
];

const DAY_ALT = DAY_NAMES.join("|");

/**
 * One spelling for every way of writing a day, date or time: lower case, full day and month
 * names, day ranges written out ("mon–fri" → "monday tuesday … friday"), "weekdays" as the
 * five days, and times as "8am" / "10:30pm" ("8 a.m.", "8:00 am", "8 AM" all read "8am").
 */
export function normalizeWhen(text: string): string {
  let s = text ?? "";
  for (const [re, day] of DAY_ABBR) s = s.replace(re, day);
  s = s.toLowerCase().replace(/[’‘]/g, "'");
  // Full names with a stray full stop or plural ("Mondays") read as the day.
  s = s.replace(new RegExp(`\\b(${DAY_ALT})s\\b`, "g"), "$1");
  s = s.replace(/\bweekdays\b/g, "monday tuesday wednesday thursday friday");
  s = s.replace(
    new RegExp(`\\b(${DAY_ALT})\\s*(?:-|–|—|to|through|thru|until|till)\\s*(${DAY_ALT})\\b`, "g"),
    (_m, a: string, b: string) => {
      const i = DAY_NAMES.indexOf(a as (typeof DAY_NAMES)[number]);
      const j = DAY_NAMES.indexOf(b as (typeof DAY_NAMES)[number]);
      const out: string[] = [];
      for (let k = i; ; k = (k + 1) % 7) {
        out.push(DAY_NAMES[k]!);
        if (k === j || out.length > 7) break;
      }
      return out.join(" ");
    },
  );
  // Times: "8 a.m.", "8 a. m.", "8:00 AM", "8am" → "8am"; "10:30 pm" → "10:30pm".
  s = s.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?\s?m\b\.?/g,
    (_m, h: string, mm: string | undefined, ap: string) =>
      `${Number(h)}${mm && mm !== "00" ? `:${mm}` : ""}${ap}m`,
  );
  // Month abbreviations before a day: "nov 27" / "Nov. 27th" → "november 27".
  s = s.replace(
    /\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?(?=\s+\d)/g,
    (m) => MONTHS[m.replace(".", "")] ?? m,
  );
  s = s.replace(
    new RegExp(`\\b(${MONTH_NAMES.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, "g"),
    "$1 $2",
  );
  return s.replace(/[ \t]+/g, " ");
}

/** A day, date or time found in a text: `key` is compared, `label` is shown to the owner. */
export type WhenToken = { key: string; label: string };

/** What may follow "at 9" / "around 8" for it to read as a time (not "at 9 Elm St"). */
const AFTER_BARE_HOUR = new RegExp(
  `^(?:\\s*$|\\s*[.,!?;)\\n]|\\s+(?:sharp|on the dot|works?|would|is|if|or|and|then|for|to|tomorrow|today|tonight|this|next|on|in the|ok|okay|fine|good|great|please|sounds|${DAY_ALT})\\b)`,
);

const hourOk = (h: number, mm?: string) =>
  mm ? h >= 0 && h <= 23 && Number(mm) < 60 : h >= 1 && h <= 12;

/** "t:<hour>:<minutes>:<am|pm|>" so "at 8" and "8am" can be matched up. */
const timeKey = (h: number, mm: string | undefined, ap: string) => `t:${h}:${mm ?? "00"}:${ap}`;

const HOLIDAYS =
  "thanksgiving|christmas|new year'?s(?: day| eve)?|easter|memorial day|labor day|the 4th|fourth of july|the holidays";

/**
 * The days, dates, times and loose "when" phrases in a text (already normalised or not —
 * it's normalised here). Each phrase family keeps its own key prefix.
 */
export function whenTokens(raw: string): WhenToken[] {
  const s = normalizeWhen(raw);
  const out: WhenToken[] = [];
  const add = (key: string, label: string) => out.push({ key, label: label.trim() });

  for (const m of s.matchAll(new RegExp(`\\b(${DAY_ALT})\\b`, "g"))) add(`d:${m[1]}`, m[1]!);
  for (const m of s.matchAll(
    /\b(tomorrow|tonight|this (?:morning|afternoon|evening|week(?:end)?)|next week|in the (?:morning|afternoon|evening))\b/g,
  ))
    add(`r:${m[1]}`, m[1]!);

  // Times with am/pm (normalised), noon and midnight.
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?([ap]m)\b/g)) {
    const h = Number(m[1]);
    if (hourOk(h) || hourOk(h, m[2])) add(timeKey(h, m[2], m[3]!), m[0]);
  }
  for (const m of s.matchAll(/\b(noon|midnight)\b/g))
    add(timeKey(12, undefined, m[1] === "noon" ? "pm" : "am"), m[1]!);
  // "9 o'clock".
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?o'?clock\b/g)) {
    const h = Number(m[1]);
    if (hourOk(h)) add(timeKey(h, m[2], ""), m[0]);
  }
  // "at 9", "at 10:30", "around 8", "at 9 sharp".
  for (const m of s.matchAll(/\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?(?![\d:])/g)) {
    const rest = s.slice(m.index! + m[0].length);
    if (/^[.,]\d|^\s*(?:%|\$|-\s?\d)/.test(rest)) continue;
    if (!m[2] && !AFTER_BARE_HOUR.test(rest)) continue;
    const h = Number(m[1]);
    if (!hourOk(h, m[2])) continue;
    add(timeKey(h, m[2], ""), m[0]);
  }
  // "9:30" on its own (not a ratio of bigger numbers, not money).
  for (const m of s.matchAll(/(?<![\d$.:/])\b(\d{1,2}):([0-5]\d)\b(?![:\d]|[ap]m)/g)) {
    const h = Number(m[1]);
    if (hourOk(h, m[2])) add(timeKey(h, m[2], ""), m[0]);
  }

  // Dates: "11/27", "november 27", "the 27th".
  for (const m of s.matchAll(/(?<![\d/])\b(\d{1,2})\/(\d{1,2})\b(?!\/\d)/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    // "1/2 inch", "3/4 ply": a fraction, not a date.
    if (a < b && [2, 3, 4, 8, 16, 32].includes(b)) continue;
    if (a < 1 || a > 12 || b < 1 || b > 31) continue;
    add(`date:${Number(m[1])}/${Number(m[2])}`, m[0]);
    add(`dom:${Number(m[2])}`, m[0]);
  }
  for (const m of s.matchAll(new RegExp(`\\b(${MONTH_NAMES.join("|")}) (\\d{1,2})\\b`, "g"))) {
    const month = MONTH_NAMES.indexOf(m[1]!) + 1;
    add(`date:${month}/${Number(m[2])}`, m[0]);
    add(`dom:${Number(m[2])}`, m[0]);
  }
  for (const m of s.matchAll(
    /\b(?:on |by )?the (\d{1,2})(?:st|nd|rd|th)\b(?! (?:floor|time|step|stair|row|grade|generation|percent))/g,
  ))
    add(`dom:${Number(m[1])}`, m[0].replace(/^(on|by) /, ""));

  // Loose timing (review A2), plus Check 23 P4's deadlines and lead times.
  for (const m of s.matchAll(
    /\b(later today|today|asap|a\.s\.a\.p|same[- ]day|first thing|before the day is out|within (?:the|an|a|one|two|three|\d+) (?:hour|day|week)s?|(?:by )?(?:the )?end of (?:the )?(?:day|week|month))\b|\bin (?:an?|one|two|three|a few|a couple(?: of)?|\d{1,2}) (?:hours?|hrs?|minutes?|mins?|days?|weeks?)\b|\bby (?:tonight|tomorrow|the weekend)\b|\bbetween \d{1,2}(?::\d{2})?(?:am|pm)? and \d{1,2}(?::\d{2})?(?:am|pm)?\b/g,
  )) {
    const phrase = m[0].replace(/^by (?:the )?end/, "end").replace(/^the end/, "end");
    add(`l:${phrase.replace(/^a\.s\.a\.p$/, "asap").replace(/^same day$/, "same-day")}`, m[0]);
  }
  // Holidays as deadlines: "before Thanksgiving". Any mention of the holiday in the source
  // allows it (the customer's "for Christmas" lets the draft say "before Christmas").
  for (const m of s.matchAll(
    new RegExp(`\\b(?:before|by|after|for|until|till|on) (${HOLIDAYS})\\b`, "g"),
  ))
    add(`h:${m[1]!.replace(/^the /, "")}`, m[0]);
  // Lead times: "three weeks out", "booked up through november".
  for (const m of s.matchAll(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple(?: of)?|a)(?:\s?(?:-|to)\s?(?:\d+|two|three|four|five|six|seven|eight))? (?:weeks?|months?) out\b/g,
  ))
    add(`lead:${m[0]}`, m[0]);
  for (const m of s.matchAll(
    /\bbooked (?:out|up|solid) (?:through|thru|until|till|to) ([a-z]+(?: \d{1,2})?)/g,
  ))
    add(`lead:booked ${m[1]}`, m[0]);
  return out;
}

/** Whether a time token is allowed by what the sources said ("at 8" matches "8am"). */
function timeAllowed(key: string, allowed: Set<string>): boolean {
  if (allowed.has(key)) return true;
  const [, h, mm, ap] = key.split(":");
  if (ap) return allowed.has(`t:${h}:${mm}:`);
  return allowed.has(`t:${h}:${mm}:am`) || allowed.has(`t:${h}:${mm}:pm`);
}

/** Holiday tokens from a source: any mention of the holiday at all. */
function holidayKeys(raw: string): string[] {
  return [...normalizeWhen(raw).matchAll(new RegExp(`\\b(${HOLIDAYS})\\b`, "g"))].map(
    (m) => `h:${m[1]!.replace(/^the /, "")}`,
  );
}

export type WhenSources = {
  /** The conversation, seasonal notes (and their end dates), the owner's instruction. */
  text: string;
  /** The business hours: their times always count; their days only when `allowHours`. */
  hours?: string | null;
  allowHours?: boolean;
  /** The owner's lead time: only lead-time phrases ("two weeks out") count from it. */
  leadTime?: string | null;
};

/** The body's when-tokens that no source said, once each (by key). */
export function newWhenTokens(body: string, src: WhenSources): WhenToken[] {
  const allowed = new Set<string>([
    ...whenTokens(src.text).map((t) => t.key),
    ...holidayKeys(src.text),
  ]);
  if (src.hours) {
    for (const t of whenTokens(src.hours)) {
      if (t.key.startsWith("t:") || src.allowHours) allowed.add(t.key);
    }
  }
  if (src.leadTime) {
    for (const t of whenTokens(src.leadTime)) if (t.key.startsWith("lead:")) allowed.add(t.key);
  }
  const seen = new Set<string>();
  const out: WhenToken[] = [];
  for (const t of whenTokens(body)) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const ok = t.key.startsWith("t:") ? timeAllowed(t.key, allowed) : allowed.has(t.key);
    if (!ok) out.push(t);
  }
  return out;
}

/** "2026-11-27" → "November 27" (a seasonal note's last day, as a draft would write it). */
export function spellDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const name = MONTH_NAMES[Number(m[2]) - 1];
  if (!name) return isoDate;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${Number(m[3])}`;
}

/**
 * The customer asked when the owner is open or available ("what are your hours?"): then the
 * hours line counts as availability the draft may give (Check 23 P3).
 */
export function asksWhenAvailable(text: string): boolean {
  return /\b(?:what are your hours|your (?:business )?hours|what hours|when are you (?:open|available|free)|what days (?:do you|are you)|are you open (?:on )?(?:weekends|saturdays?|sundays?)|your availability|when do you work)\b/i.test(
    text ?? "",
  );
}

/** Words that mean a day relative to when they were written. */
export const RELATIVE_DAYS = ["today", "tonight", "tomorrow"] as const;
