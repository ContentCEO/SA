/**
 * Check 38 P2: the largest deposit share a payment-terms line (or a draft) states, so a
 * Massachusetts shop asking for more than one-third is told. Pure: no database, no model.
 */
import { MA_DEPOSIT_MAX_SHARE, MA_DEPOSIT_SETTINGS_LINE } from "@/config/ma-rules";

/** Words that make a share a deposit: paid before the work, to book or start it. */
const DEPOSIT_CONTEXT =
  /\b(?:deposit|down|up ?front|upfront|at signing|on signing|when you sign|to start|to book|to get (?:you )?on the schedule|to schedule|before (?:we )?start|in advance|retainer|due now|now)\b/i;

const WORD_SHARES: [RegExp, number][] = [
  [/\b(?:a|one)[- ]third\b/gi, 1 / 3],
  [/\btwo[- ]thirds?\b/gi, 2 / 3],
  [/\b(?:a|one)[- ]quarter\b/gi, 1 / 4],
  [/\bthree[- ]quarters\b/gi, 3 / 4],
  [/\bhalf\b/gi, 1 / 2],
  [/\b(?:in full|full payment|the full amount|the whole amount)\b/gi, 1],
];

/**
 * The words around a match that say what it is paid for: the same clause, up to 40 characters
 * either side ("30% up front and 70% on completion": the 70% is the clause after "and").
 */
function nearby(text: string, start: number, end: number): string {
  const clause = /[.!?;,\n]|\band\b|\bthen\b|\bwith\b/i;
  const before =
    text
      .slice(Math.max(0, start - 40), start)
      .split(clause)
      .pop() ?? "";
  const after = text.slice(end, end + 40).split(clause)[0] ?? "";
  return `${before} ${after}`;
}

/** The largest deposit share stated (0–1), or null when the text states none. */
export function depositShare(text: string | null | undefined): number | null {
  const t = text ?? "";
  const shares: number[] = [];
  // "50%", "40 percent", "33 %".
  for (const m of t.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s?(?:%|percent\b)/gi)) {
    const n = Number(m[1]);
    if (n <= 0 || n > 100) continue;
    if (DEPOSIT_CONTEXT.test(nearby(t, m.index!, m.index! + m[0].length))) shares.push(n / 100);
  }
  // "half down", "a third at signing", "two-thirds up front".
  for (const [re, share] of WORD_SHARES)
    for (const m of t.matchAll(re))
      if (DEPOSIT_CONTEXT.test(nearby(t, m.index!, m.index! + m[0].length))) shares.push(share);
  // "60/40", "50/50": the first number is paid first.
  for (const m of t.matchAll(/\b(\d{1,2})\s?\/\s?(\d{1,2})\b(?!\s?\/)/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a + b === 100 && a > 0) shares.push(a / 100);
  }
  return shares.length ? Math.max(...shares) : null;
}

/** More than Massachusetts allows (a hair over a third: "33%" and "one-third" are fine). */
export function overMaDepositCap(
  state: string | null | undefined,
  text: string | null | undefined,
) {
  if ((state ?? "").toUpperCase() !== "MA") return false;
  const share = depositShare(text);
  return share !== null && share > MA_DEPOSIT_MAX_SHARE + 1e-9;
}

/** The line under "How do you get paid?" for an MA shop whose terms ask for more, else null. */
export function depositTermsWarning(
  state: string | null | undefined,
  paymentTerms: string | null | undefined,
): string | null {
  return overMaDepositCap(state, paymentTerms) ? MA_DEPOSIT_SETTINGS_LINE : null;
}
