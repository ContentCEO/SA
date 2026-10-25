import { PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

/**
 * Check 47 P3: who hosts an email domain, so /admin can say which waitlist sign-ups aren't on
 * Google before Davi invites them (only Gmail and Google Workspace can connect today). Pure: the
 * domain and its MX hosts in, one of four words out.
 */
export type MailHost = "google" | "microsoft" | "other" | "unknown";

export const MAIL_HOSTS: readonly MailHost[] = ["google", "microsoft", "other", "unknown"];
export const isMailHost = (v: unknown): v is MailHost =>
  typeof v === "string" && (MAIL_HOSTS as readonly string[]).includes(v);

const GOOGLE_WEBMAIL = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_WEBMAIL = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const endsWith = (h: string, suffix: string) => h === suffix || h.endsWith(`.${suffix}`);

/** The domain of an address, lowercased, or null. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = host(email.slice(at + 1));
  return /^[a-z0-9.-]+$/.test(d) ? d : null;
}

export function mailHostFor(domain: string, mxHosts: readonly string[]): MailHost {
  const d = host(domain);
  if (GOOGLE_WEBMAIL.has(d)) return "google";
  if (MICROSOFT_WEBMAIL.has(d)) return "microsoft";
  if (PUBLIC_WEBMAIL_DOMAINS.has(d)) return "other";
  const mx = mxHosts.map(host).filter(Boolean);
  // A look-alike (evilgoogle.com) is not Google: only google.com itself and its subdomains.
  if (mx.some((h) => endsWith(h, "google.com") || endsWith(h, "googlemail.com"))) return "google";
  if (mx.some((h) => endsWith(h, "mail.protection.outlook.com"))) return "microsoft";
  return "unknown";
}

/** The admin card's line; nothing for Google or for rows from before the column. */
export function mailHostLine(mailHost: string | null): string | null {
  switch (mailHost) {
    case "microsoft":
      return "Email on Microsoft (Outlook)";
    case "other":
      return "Email not on Google";
    case "unknown":
      return "Couldn't tell where their email is hosted";
    default:
      return null;
  }
}

/**
 * Inviting an address we know isn't on Google takes one more tap. "unknown" (DNS didn't answer)
 * only shows the line: a custom domain must stay invitable when the lookup failed.
 */
export const INVITE_NOT_GOOGLE_CONFIRM =
  "This address isn't on Gmail, so they can't connect yet. Invite anyway?";
export const needsInviteConfirm = (mailHost: string | null, outlookOn = false) =>
  // Plan #49: once Outlook can connect (FEATURE_OUTLOOK on), a Microsoft address is invited
  // like a Google one. Callers pass outlookOffered(); off, nothing changes.
  (mailHost === "microsoft" && !outlookOn) || mailHost === "other";
