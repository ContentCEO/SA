/**
 * Pure rules for the Inbox screen (outside review: say on each row whether it's answered).
 */

export type ReplyState = "Replied" | "Waiting on you";

/**
 * "Replied" when the owner wrote after the customer's latest email, "Waiting on you" when the
 * customer wrote last. Junk and threads with no customer email get no word. Both times come
 * from the same "who wrote last" reads as everywhere else (no unsent Gmail drafts, no side
 * conversations).
 */
export function replyState(r: {
  lastIn: Date | null;
  lastOut: Date | null;
  category: string | null;
}): ReplyState | null {
  if (r.category === "noise" || !r.lastIn) return null;
  return r.lastOut && r.lastOut >= r.lastIn ? "Replied" : "Waiting on you";
}

/** What a typed search looks through on a row, lowercased. Never leaves the phone. */
export function searchText(r: {
  senderName: string | null;
  senderAddress: string | null;
  subject: string | null;
  summary: string | null;
  categoryLabel: string | null;
}): string {
  return [r.senderName, r.senderAddress, r.subject, r.summary, r.categoryLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** True when every word typed appears somewhere in the row's text. */
export function matchesSearch(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w));
}
