import type { Category } from "@/ai/prompts/classify.v4";

/** What the owner sees. Plain words, in the order the filter chips appear. */
export const categoryLabels: Record<Category, string> = {
  quote_request: "Quote requests",
  customer_question: "Questions",
  scheduling: "Scheduling",
  invoice_payment: "Invoices & payments",
  complaint: "Complaints",
  supplier_vendor: "Suppliers",
  noise: "Junk & notices",
};

/** Singular, for a single row's tag. */
export const categoryTag: Record<Category, string> = {
  quote_request: "Quote request",
  customer_question: "Question",
  scheduling: "Scheduling",
  invoice_payment: "Invoice / payment",
  complaint: "Complaint",
  supplier_vendor: "Supplier",
  noise: "Junk / notice",
};

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && v in categoryLabels;
}

/**
 * A queue card's tag. Deposit details are always about a quote, even when the acceptance
 * itself was re-sorted as scheduling (A5), so they always say "Quote request".
 */
export function draftTag(d: {
  category: string | null;
  kind: "reply" | "followup" | null;
  purpose: string | null;
}): string {
  const category = isCategory(d.category) ? categoryTag[d.category] : "Email";
  if (d.purpose === "deposit") return `Deposit details · ${categoryTag.quote_request}`;
  if (d.purpose === "review_request") return "Review request";
  if (d.purpose === "closing_question") return "Closing question";
  if (d.purpose === "safety") return "Gas smell · safety note";
  return d.kind === "followup" ? `Follow-up · ${category}` : category;
}
