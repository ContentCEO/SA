import { hasUnfilledGap } from "@/ai/gaps";
import type { Category } from "@/ai/prompts/classify.v2";
import { confidenceLabel } from "@/config/drafting";

/** Plan #5: the categories "Review all ready" may ever include. Never complaints or junk. */
export const BATCH_CATEGORIES = [
  "quote_request",
  "customer_question",
  "scheduling",
  "invoice_payment",
  "supplier_vendor",
] as const satisfies readonly Category[];
export type BatchCategory = (typeof BATCH_CATEGORIES)[number];
export const isBatchCategory = (v: unknown): v is BatchCategory =>
  typeof v === "string" && (BATCH_CATEGORIES as readonly string[]).includes(v);

export type BatchCandidate = {
  category: string | null;
  needsOwner: boolean;
  flags: string[];
  confidencePct: number | null;
  body: string;
  /** Dollar amounts the classifier found in the customer's email. */
  amountsInEmail: number[];
  /** Injection or building-department mail: always one at a time. */
  untrusted: boolean;
  /** Autopilot is counting down on it; that has its own window. */
  autopilotCounting: boolean;
};

/**
 * Whether a draft may go out in a batch. Checked on the server against fresh
 * rows, whatever IDs the browser sends.
 */
export function batchEligible(c: BatchCandidate, picked: readonly string[]): boolean {
  if (!isBatchCategory(c.category) || !picked.includes(c.category)) return false;
  if (c.needsOwner || c.untrusted || c.autopilotCounting) return false;
  if (c.flags.length > 0 || hasUnfilledGap(c.body)) return false;
  if (c.category === "invoice_payment" && c.amountsInEmail.length > 0) return false;
  return confidenceLabel({ confidencePct: c.confidencePct, flags: 0, gaps: 0 }) === "ready";
}

/** The first line of a draft, after the greeting, for the review list. */
export function firstLine(body: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const greeting = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^.!?]{0,40}[,!.]?$/i;
  const line = lines.find((l) => !greeting.test(l)) ?? lines[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
