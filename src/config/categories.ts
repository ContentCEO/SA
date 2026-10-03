import type { Category } from "@/ai/prompts/classify.v1";

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
