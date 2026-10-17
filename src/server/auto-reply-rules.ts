/**
 * Automatic replies and bounces, as pure rules (Check 20 P4 + Check 21 P1). An out-of-office,
 * an auto-responder or a mailer-daemon bounce is neither an answer from the customer nor
 * something to reply to: it is stored with `messages.auto_reply`, sorted as nothing (no model
 * call), never drafted for by a job, never sent to by autopilot, and every "who wrote last"
 * question skips it. Only the flag is kept: header values are never stored or logged.
 *
 * RFC 3834 (https://www.rfc-editor.org/rfc/rfc3834): automatic responses carry an
 * Auto-Submitted header other than "no", and nothing automatic should answer them.
 */

/** The headers that say a message was written by a machine (read at sync, never stored). */
export type AutoReplyHeaders = {
  subject?: string;
  autoSubmitted?: string;
  xAutoreply?: string;
  xAutorespond?: string;
  precedence?: string;
};

const AUTO_SUBJECT = /^\s*(automatic reply\s*:|auto\s*:|out of (the )?office|autoreply)/i;
const AUTO_PRECEDENCE = new Set(["auto_reply", "bulk", "junk", "list"]);

/** A mailer-daemon / postmaster address: the email the owner sent didn't arrive. */
export function isBounceSender(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return false;
  return /^(mailer-daemon|postmaster)$/.test(s.slice(0, at));
}

/**
 * True for an automatic reply: Auto-Submitted present and not "no", any X-Autoreply /
 * X-Autorespond, Precedence auto_reply / bulk / junk / list, a subject that starts like an
 * out-of-office ("Automatic reply:", "Auto:", "Out of Office", "Autoreply"), or a bounce.
 * The body is never read: "I'll be out of office Friday" in an ordinary email is not one.
 */
export function isAutoReply(h: AutoReplyHeaders, from?: string | null): boolean {
  const auto = h.autoSubmitted?.trim().toLowerCase();
  if (auto !== undefined && auto !== "" && !/^no\b/.test(auto)) return true;
  if (h.xAutoreply !== undefined || h.xAutorespond !== undefined) return true;
  const precedence = h.precedence?.trim().toLowerCase();
  if (precedence && AUTO_PRECEDENCE.has(precedence)) return true;
  if (h.subject && AUTO_SUBJECT.test(h.subject)) return true;
  return isBounceSender(from);
}

/** The one line a card shows when the owner's email to the customer bounced (Check 21 P1). */
export const BOUNCED_LINE = "Your email to this customer bounced. Check the address.";

/** The card line for a thread's stored facts, or null. */
export function bouncedLine(extracted: unknown): string | null {
  return (extracted as { bounced?: unknown } | null)?.bounced === true ? BOUNCED_LINE : null;
}
