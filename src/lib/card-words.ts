import { categoryTag } from "@/config/categories";

/** The words a sorting reason may start with before a colon ("Scheduling: move Thursday…"). */
const PREFIXES = new Set(
  [
    ...Object.values(categoryTag),
    ...Object.keys(categoryTag).map((c) => c.replace(/_/g, " ")),
    "quote",
    "invoice",
    "payment",
    "invoice/payment",
    "question",
    "supplier",
    "vendor",
  ].map((w) => w.toLowerCase().replace(/\s+/g, " ")),
);

/**
 * Check 9 P12: a reason that repeats the card's tag ("Scheduling: move Thursday's visit") is
 * shown without it ("Move Thursday's visit"). Anything else is left as it is.
 */
export function withoutCategoryPrefix(text: string): string {
  const m = /^\s*([^:\n]{1,30}):\s+(\S[\s\S]*)$/.exec(text);
  if (!m) return text;
  const prefix = m[1]!
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/");
  if (!PREFIXES.has(prefix)) return text;
  const rest = m[2]!;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
