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
 * Check 41 P7: job boards, whose notices ("New application: Landscape Laborer") come from
 * addresses with no no-reply word (indeedapply@indeed.com, alerts@ziprecruiter.com). The whole
 * domain and its subdomains, any local part; a look-alike (indeedhomes.com) is a person.
 * Craigslist is left out: its relay addresses are real people. The SQL twin (`noReplySql`)
 * reads this same list.
 */
export const MACHINE_SENDER_DOMAINS: readonly string[] = [
  "indeed.com",
  "indeedemail.com",
  "ziprecruiter.com",
  "glassdoor.com",
  "snagajob.com",
];

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
  const domain = s.slice(at + 1);
  if (MACHINE_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
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

/**
 * The owner's business domain for a mailbox address: its domain, or null on public webmail
 * (shared with strangers, so "same domain" means nothing there).
 */
export function businessDomainOf(email: string | null | undefined): string | null {
  const s = (email ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = s.slice(at + 1);
  return domain && !PUBLIC_WEBMAIL_DOMAINS.has(domain) ? domain : null;
}

/** What "the owner's own people" is decided from (Check 22 P10 + 41 P6). */
export type CrewContext = {
  /** `business_profile.crew_addresses`: lowercased emails the owner listed. */
  listed: readonly string[];
  /** Every Gmail address connected to the workspace. */
  mailboxEmails: readonly string[];
};

/**
 * Check 22 P10 + 41 P6: an address that is one of the owner's own people, never a customer —
 * on the owner's crew list, or one of the workspace's own Gmail addresses (the owner writing
 * to themselves from another connected address). With `includeDomain`, also anyone on the
 * owner's business domain (never public webmail) — used only to file a row on Customers under
 * "Your crew and subs". Sorting, drafts, autopilot and the counts use the strict rule: an owner
 * on an internet provider's domain we don't list (charter.net, cox.net…) shares it with
 * customers, and a customer wrongly taken for crew would get no draft and no needs-you.
 * SQL twin: `crewSql` in thread-sql.ts. Pure.
 */
export function isCrewAddress(
  address: string | null | undefined,
  ctx: CrewContext,
  opts: { includeDomain?: boolean } = {},
): boolean {
  const s = (address ?? "").trim().toLowerCase();
  if (!s.includes("@")) return false;
  if (ctx.listed.some((a) => a.trim().toLowerCase() === s)) return true;
  if (ctx.mailboxEmails.some((a) => a.trim().toLowerCase() === s)) return true;
  if (!opts.includeDomain) return false;
  const domain = s.slice(s.lastIndexOf("@") + 1);
  return ctx.mailboxEmails.some((a) => businessDomainOf(a) === domain);
}
