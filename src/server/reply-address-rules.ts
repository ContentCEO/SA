/**
 * Where a reply to a customer's email goes (review "Must fix", idea B1), as pure rules.
 *
 * Website contact forms (Squarespace, Wix, WordPress, Jobber / Housecall Pro request forms)
 * email the owner from a robot address and put the customer in "Reply-To". Gmail's own Reply
 * answers the Reply-To, so we do too. The choice is made once, at sync, and stored on the
 * message (`messages.reply_to_header`); everything else reads the stored choice, in code with
 * `customerReplyAddress` and in SQL with its twin `replyAddressSql` (thread-sql.ts).
 *
 * "Who sent it" (From) is still what identity checks use: receipt senders, building
 * departments, the lead-source label. "Who we answer" (this) is what drafts, customer
 * grouping, known-customer checks and no-reply exclusions use.
 */
import { parseAddressList } from "@/mailbox/address";
import { leadPlatformOf } from "./monthly-rules";
import { isNoReplyAddress, PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

/**
 * Stored per inbound message. NULL in the database = never read; {} = read, nothing usable
 * (the reply goes to From); {address, name?} = the reply goes to this address.
 */
export type ReplyToHeader = { address?: string; name?: string };

/** An address we'd put in a MIME To: line. Already lowercased by parseAddressList. */
const USABLE_ADDRESS = /^[^\s@<>()",;:\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_ADDRESS = 254;
const MAX_NAME = 120;
const CONTROL = /[\u0000-\u001f\u007f]/;

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const s = name
    .replace(/[\u0000-\u001f\u007f"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return s || undefined;
}

/**
 * At sync: the Reply-To a reply to this email should go to, or {} when the reply goes to From.
 * Never throws. First address that passes every rule wins (drafts have one To):
 * 1. a plain, well-formed address (it ends up in a MIME To: line);
 * 2. not one of the workspace's own mailboxes, nor on their business domain (a form set to
 *    reply to the shop itself) — public webmail domains are shared with strangers, so exempt;
 * 3. not a no-reply address;
 * 4. not a lead platform's relay (Thumbtack, Angi…): those leads are answered on the platform,
 *    as before;
 * 5. not the sender itself (nothing to redirect).
 */
export function pickReplyTo(
  raw: string | undefined | null,
  o: { from: string | null | undefined; self: readonly string[] },
): ReplyToHeader {
  if (!raw || typeof raw !== "string") return {};
  const self = o.self.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ownDomains = new Set(self.map(domainOf).filter((d) => d && !PUBLIC_WEBMAIL_DOMAINS.has(d)));
  const from = (o.from ?? "").trim().toLowerCase();
  let list: { name?: string; email: string }[];
  try {
    list = parseAddressList(raw);
  } catch {
    return {};
  }
  for (const a of list) {
    const address = a.email.trim();
    if (!address || address.length > MAX_ADDRESS || CONTROL.test(address)) continue;
    if (address.split("@").length !== 2 || !USABLE_ADDRESS.test(address)) continue;
    if (self.includes(address) || ownDomains.has(domainOf(address))) continue;
    if (isNoReplyAddress(address)) continue;
    if (leadPlatformOf(address)) continue;
    if (address === from) return {};
    const name = cleanName(a.name);
    return name ? { address, name } : { address };
  }
  return {};
}

type ReplyFields = { fromAddress: string | null; replyToHeader: ReplyToHeader | null };

/** True when a reply goes somewhere other than the sender (a website form's Reply-To). */
export function replyRedirected(m: { replyToHeader: ReplyToHeader | null }): boolean {
  return !!m.replyToHeader?.address;
}

/** Where a reply to this message goes: its usable Reply-To, else its sender. Lowercased. */
export function customerReplyAddress(m: ReplyFields): string | null {
  const a = (m.replyToHeader?.address ?? m.fromAddress ?? "").trim().toLowerCase();
  return a || null;
}

/**
 * The name to show for that address: the Reply-To's own name when it redirects (possibly
 * none — never the form robot's "Squarespace" / "Wix Forms"), else the sender's name.
 */
export function customerReplyName(m: ReplyFields & { fromName: string | null }): string | null {
  if (replyRedirected(m)) return m.replyToHeader?.name ?? null;
  return m.fromName ?? null;
}

/** First flag on a draft the owner asked for that would go to a no-reply address. */
export const NO_REPLY_FLAG =
  "This goes to a no-reply address — answer them on the platform or by phone.";

/** First flag on a waiting draft moved from a form's robot address to the customer's own. */
export const REPOINTED_FLAG =
  "Now goes to the reply address the customer's email named, not the address it came from. Check the greeting.";

/**
 * Hosts that send website-form and booking-request emails from a robot address, with the
 * customer in Reply-To. A short list on purpose: anything else is worded as a person.
 */
const FORM_SENDER_DOMAINS = [
  "squarespace.info",
  "squarespace.com",
  "wix.com",
  "wixforms.com",
  "jotform.com",
  "formspree.io",
  "typeform.com",
  "webflow.io",
  "getjobber.com",
  "housecallpro.com",
];
/** A form robot's local part: wordpress@site.com, form-submission@…, webform@…, forms@…. */
const FORM_SENDER_LOCAL =
  /^(wordpress|webmaster|forms?|form[-_.]?submissions?|web-?forms?|submissions?|website)([+._-]|$)/;

/**
 * Does this From look like a website form's robot (so a reply to it reaches nobody), rather
 * than a person who named their other address in Reply-To? Used only for how firmly the
 * one-off backfill words its "a past reply went to the From" note; drafting always answers
 * the stored Reply-To either way, as Gmail's own Reply does.
 */
export function looksLikeFormSender(from: string | null | undefined): boolean {
  const s = (from ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return false;
  if (isNoReplyAddress(s)) return true;
  const domain = s.slice(at + 1);
  if (FORM_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return FORM_SENDER_LOCAL.test(s.slice(0, at));
}
