/**
 * Who sent an email, as pure rules shared by the review offer (plan #29), response time
 * (#33) and leads at risk (#34). A no-reply sender is a machine: Thumbtack / Angi "new lead"
 * mail and the like. The owner answers those on the platform, never by email, so they can
 * never be "answered" in Gmail and must not count as waiting for an answer.
 */

/**
 * The local part (before the last "@") of a machine sender. Written so the same pattern
 * works in JavaScript and in Postgres (`~`), which keeps the SQL twin below honest.
 */
export const NO_REPLY_LOCAL_PATTERN =
  "(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|form-?submissions?|wordpress|automated|auto-?reply)([._+-]|$)";

const NO_REPLY_LOCAL = new RegExp(NO_REPLY_LOCAL_PATTERN);

/**
 * noreply@thumbtack.com, do-not-reply@…, notifications@…, mailer-daemon@…, and the robots
 * round 2 found treated as people (review A9): voice-noreply@google.com,
 * form-submission@squarespace.info, wordpress@site.com, bounces+…@, postmaster@. A no-reply
 * word anywhere in the local part counts, as a whole word ("noreplyguy@" is a person).
 */
export function isNoReplyAddress(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return false;
  return NO_REPLY_LOCAL.test(s.slice(0, at));
}

/**
 * Public webmail: everyone on these shares the domain with strangers, so "same domain" means
 * nothing there (the referral same-domain block, and an owner's email to their own crew).
 */
export const PUBLIC_WEBMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "comcast.net",
  "att.net",
  "verizon.net",
]);
