/**
 * Pure rules for the Inbox screen (outside review: say on each row whether it's answered).
 */

export type ReplyState = "Replied" | "Waiting on you";

/**
 * Junk that can be folded out of sight: sorted as noise AND not needing the owner. Noise can
 * still need them (a VIP, an amount over their threshold, a low-confidence sort, an email that
 * tries to instruct the assistant, or their own "This one needs me"), and those stay in the list.
 */
export function isFoldableJunk(r: { category: string | null; needsOwner: boolean }): boolean {
  return r.category === "noise" && !r.needsOwner;
}

/**
 * "Replied" when the owner wrote after the customer's latest email, "Waiting on you" when the
 * customer wrote last. Junk (noise that doesn't need the owner) and threads with no customer
 * email get no word. Both times come from the same "who wrote last" reads as everywhere else
 * (no unsent Gmail drafts, no side conversations).
 */
export function replyState(r: {
  lastIn: Date | null;
  lastOut: Date | null;
  category: string | null;
  needsOwner: boolean;
}): ReplyState | null {
  if (isFoldableJunk(r) || !r.lastIn) return null;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Check 10 P3: an emergency or urgent email counts as "today's" for this long. */
export const INBOX_URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type InboxRankInput = {
  id: string;
  urgency: string | null;
  priority: string | null;
  /** Open needs-you (flagged and not answered since). */
  needsOwner: boolean;
  lastMessageAt: Date | null;
  lastIn: Date | null;
  lastOut: Date | null;
};

/**
 * Check 10 P3: the Inbox's tier, mirrored by the SQL order in inbox.ts. Higher comes first:
 * 4 = an emergency from the last 24 hours that the customer wrote last on, 2 = needs you,
 * 1 = urgent (priority high) from the last 24 hours; added together.
 */
export function inboxTier(r: InboxRankInput, now: Date): number {
  const recent =
    r.lastMessageAt != null && r.lastMessageAt.getTime() > now.getTime() - INBOX_URGENT_WINDOW_MS;
  const customerWaiting = r.lastIn != null && (r.lastOut == null || r.lastOut < r.lastIn);
  const emergency = r.urgency === "emergency" && recent && customerWaiting;
  const urgent = r.priority === "high" && recent;
  return (emergency ? 4 : 0) + (r.needsOwner ? 2 : 0) + (urgent ? 1 : 0);
}

/**
 * Check 10 P3: where a row sorts: tier (high first), then newest, then id (a stable tie-break,
 * also descending). Mirrors listInboxThreads' ORDER BY.
 */
export function inboxRank(r: InboxRankInput, now: Date): [number, number, string] {
  return [inboxTier(r, now), r.lastMessageAt?.getTime() ?? -Infinity, r.id];
}

/** Sort comparator for `inboxRank`: first in the Inbox first. */
export function compareInbox(a: InboxRankInput, b: InboxRankInput, now: Date): number {
  const [ta, la, ia] = inboxRank(a, now);
  const [tb, lb, ib] = inboxRank(b, now);
  if (ta !== tb) return tb - ta;
  if (la !== lb) return lb > la ? 1 : -1;
  return ia === ib ? 0 : ia < ib ? 1 : -1;
}

/** Check 10 P3: the word that leads a card's tag line, by weight only. */
export function urgencyWord(r: { urgency: string | null; priority: string | null }) {
  if (r.urgency === "emergency") return "Emergency";
  if (r.priority === "high") return "Urgent";
  return null;
}

/**
 * Check 10 P7: never sorted, and the latest customer email is older than the sorter looks
 * back, so it never will be (it sat in Gmail before Squared Away started). Folded on All.
 */
export function isOlderUnsorted(
  r: { category: string | null; lastIn: Date | null; lastMessageAt: Date | null },
  now: Date,
  lookbackDays: number,
): boolean {
  const at = r.lastIn ?? r.lastMessageAt;
  return r.category === null && at != null && at.getTime() < now.getTime() - lookbackDays * DAY_MS;
}


/**
 * Check 10 P7: the kind word on a card. A sort that failed says so instead of a placeholder
 * category; never-sorted mail says whether a sort is still coming.
 */
export function kindWord(
  r: { category: string | null; extracted: Record<string, unknown> | null },
  tags: Record<string, string>,
  olderUnsorted: boolean,
): string {
  if (r.extracted?.unreadable === true) return "Couldn't sort";
  if (r.category === null) return olderUnsorted ? "Not sorted" : "Not sorted yet";
  return tags[r.category] ?? "Email";
}
