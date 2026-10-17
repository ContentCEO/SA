import { numberWord } from "./number-words";

/**
 * Check 35 P1: the trial's length in words, from a number of days (pricing.evaluationDays, or an
 * account's own clock after an extension), never typed by hand. Pure, for any page or email.
 */

/** "three" (one to ten as words, digits above). */
export const dayWord = numberWord;

/** "three days" / "one day". */
export function daysPhrase(n: number): string {
  return `${dayWord(n)} day${n === 1 ? "" : "s"}`;
}

/** "three-day", as in "your three-day trial". */
export function dayAdjective(n: number): string {
  return `${dayWord(n)}-day`;
}

/** The same with a capital first letter, to start a sentence. */
export function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
