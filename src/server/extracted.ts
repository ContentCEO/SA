import { z } from "zod";

/**
 * Check 30 P6: one reader for `threads.extracted`. Its shape grew with each classify prompt
 * (v1: the job facts; v2: permit + invoice; v3: acceptance / job-done signals; v4+: who owes the
 * bill), and old rows keep their old shape. `threads.classified_prompt_version` says which
 * version wrote a row (null = written before that column, read as the newest shape, since every
 * key is optional).
 *
 * Reads loosely, like the readers it replaced: a field with an odd value reads as missing, never
 * an error, and keys this code doesn't know pass through untouched (newer code may write them
 * to the shared database). Only a value that isn't an object at all is refused (null).
 */

/** A field that reads as missing when it's absent or holds something unexpected. */
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const trueFlag = loose(z.literal(true));
const isoText = loose(z.string());

/** classify.v1: the job facts the model pulls out of an email. */
const v1 = z.looseObject({
  service_requested: loose(z.string().nullable()),
  address: loose(z.string().nullable()),
  dates: loose(z.array(z.string())),
  dollar_amounts: loose(z.array(z.number())),
  urgency: loose(z.enum(["emergency", "high", "normal", "low"])),
  /** Code-side marks (since classify.v2's guards). */
  municipal: loose(z.boolean()),
  injection: loose(z.boolean()),
});

/** classify.v2: permit and invoice facts (each read loosely by its own reader). */
const v2 = v1.extend({
  permit: loose(z.looseObject({}).nullable()),
  invoice: loose(z.looseObject({}).nullable()),
  invoice_thread: trueFlag,
});

/** classify.v3: the acceptance / job-done signals and the code's quote acceptance. */
const v3 = v2.extend({
  accepts_quote: trueFlag,
  job_done: trueFlag,
  quote_accepted: trueFlag,
  quote_accepted_at: isoText,
});

/** classify.v4 and later: who owes the bill, and what this email said about paying. */
const v4 = v3.extend({
  invoice_direction: loose(z.enum(["owed_to_business", "owed_by_business", "unknown"])),
  payment_said: loose(z.enum(["paid", "partly_paid"])),
});

const BY_VERSION: Record<string, z.ZodType> = {
  "classify.v1": v1,
  "classify.v2": v2,
  "classify.v3": v3,
};

export type ExtractedFacts = z.output<typeof v4>;

/** The schema for a prompt version: its own, else the newest shape (every key optional). */
function schemaFor(version: string | null | undefined): z.ZodType {
  return (version && BY_VERSION[version]) || v4;
}

/**
 * `threads.extracted`, validated for the version that wrote it. Null when there's nothing to
 * read (null, a string, an array…). Fields a version didn't have read as missing.
 */
export function readExtracted(extracted: unknown, version?: string | null): ExtractedFacts | null {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return null;
  const parsed = schemaFor(version).safeParse(extracted);
  return parsed.success ? (parsed.data as ExtractedFacts) : null;
}
