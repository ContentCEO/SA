const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** A small whole number as a word ("two"), digits above ten ("14"), as plain copy writes them. */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 10 ? WORDS[n] : String(n);
}
