/**
 * Replies package (draft.v7): warm first replies to new leads, as pure rules. When a draft
 * is a first contact, the drafter picks a shape from what the customer said; the queue card
 * says so ("First reply: asks 2 questions · they described the job") and offers three other
 * ways to reply. Keys and counts only — never the customer's words. No database here.
 */
import type { Opening } from "@/ai/prompts/draft.v7";

/** The kinds of email a first reply is written for: someone asking about a job. */
export const FIRST_CONTACT_CATEGORIES = [
  "quote_request",
  "customer_question",
  "scheduling",
] as const;

/** The four first-reply shapes (draft.v7). "not_first" is none of them. */
export const FIRST_CONTACT_OPENINGS = ["details", "vague", "urgent", "price_only"] as const;
export type FirstContactOpening = (typeof FIRST_CONTACT_OPENINGS)[number];

export const isFirstContactOpening = (v: unknown): v is FirstContactOpening =>
  typeof v === "string" && (FIRST_CONTACT_OPENINGS as readonly string[]).includes(v);

/**
 * Whether this draft gets the first-contact guidance. An ordinary reply only — never a
 * nudge, a purpose note (deposit, review request, closing question) or the gas-smell safety
 * note, whose own flow stays as it is — to someone asking about a job, when the owner has
 * never written to them (no email from any of the owner's mailboxes, no reply sent from the
 * app, no "I called them" on this conversation; side emails to the crew don't count).
 */
export function isFirstContact(t: {
  followup: boolean;
  purpose: string | null;
  category: string | null;
  gasSmell: boolean;
  ownerWroteBefore: boolean;
  handledOffline: boolean;
}): boolean {
  return (
    !t.followup &&
    t.purpose === null &&
    !t.gasSmell &&
    !t.ownerWroteBefore &&
    !t.handledOffline &&
    (FIRST_CONTACT_CATEGORIES as readonly string[]).includes(t.category ?? "")
  );
}

/** What gets stored on the draft: the model's shape on a first contact, else nothing. */
export function storedOpening(firstContact: boolean, modelOpening: Opening | undefined) {
  return firstContact ? (modelOpening ?? "not_first") : null;
}

/** Questions asked in a draft: each run of "?" counts once ("really??" is one). */
export function questionCount(body: string | null | undefined): number {
  return (body ?? "").match(/\?+/g)?.length ?? 0;
}

const SHAPE_NOTE: Record<FirstContactOpening, string> = {
  details: "they described the job",
  vague: "they didn't say much yet",
  urgent: "sounds urgent",
  price_only: "they asked about price",
};

/**
 * The card's line on a first reply: "First reply: asks 2 questions · they described the
 * job". Counted from the text as it stands now (a tweak changes the count); null on any
 * other draft.
 */
export function openingLine(opening: string | null, body: string | null): string | null {
  if (!isFirstContactOpening(opening)) return null;
  const n = questionCount(body);
  const asks = n === 0 ? "no questions" : `${n} question${n === 1 ? "" : "s"}`;
  return `First reply: asks ${asks} · ${SHAPE_NOTE[opening]}`;
}

/** "Other ways to reply" shows on a first reply only, while it can still be changed. */
export function offersOtherWays(d: {
  opening: string | null;
  revisionsLeft: number;
  readOnly: boolean;
}): boolean {
  return isFirstContactOpening(d.opening) && d.revisionsLeft > 0 && !d.readOnly;
}
