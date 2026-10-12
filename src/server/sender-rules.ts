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
  "^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon)([+.-]|$)";

const NO_REPLY_LOCAL = new RegExp(NO_REPLY_LOCAL_PATTERN);

/** noreply@thumbtack.com, do-not-reply@…, notifications@…, mailer-daemon@… (any case). */
export function isNoReplyAddress(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return false;
  return NO_REPLY_LOCAL.test(s.slice(0, at));
}
