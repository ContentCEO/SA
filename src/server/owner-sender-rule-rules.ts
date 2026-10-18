/**
 * Ideas H3: the owner's own sender rules, as pure rules (no database).
 *
 * A rule is keyed on ONE address or on a company's web address ("everyone at hillpm.com").
 * Three actions: Always junk, Never draft, Always needs me (company-wide only — "always needs
 * me" for one address is the VIP list, one place for that fact).
 *
 * Direction (who a rule may match): rules that ADD caution (needs me, never draft, a VIP)
 * match the sender OR the reply address. The one rule that REMOVES caution (junk) matches only
 * when the sender matches and the email names no other reply address — or that one matches
 * too — so a spammer can't borrow a rule by naming a ruled address in Reply-To, and a form
 * robot can't carry one customer's rule to the next. Any caution beats junk.
 */
import type { OwnerSenderRuleAction, OwnerSenderRuleScope } from "@/db/schema";
import { leadPlatformOf } from "./monthly-rules";
import type { ReplyToHeader } from "./reply-address-rules";
import { isNoReplyAddress, PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";
import { isEmailToTextAddress } from "./channel-rules";

export type SenderRule = {
  pattern: string;
  scope: OwnerSenderRuleScope;
  action: OwnerSenderRuleAction;
};

/** Backstop against a runaway, never a number the owner is told about in advance. */
export const MAX_SENDER_RULES = 200;

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** An address or a web address as stored: trimmed, lowercased. */
export const normalizePattern = (p: string) => p.trim().toLowerCase();

/** The domain of an address (after the last "@"), or null. */
export function domainOf(address: string | null | undefined): string | null {
  const a = normalizePattern(address ?? "");
  const at = a.lastIndexOf("@");
  if (at <= 0) return null;
  const d = a.slice(at + 1);
  return HOST.test(d) ? d : null;
}

/** `address` falls under `domain` (the same host, or one of its subdomains — never "xhillpm.com"). */
export function underDomain(address: string | null | undefined, domain: string): boolean {
  const d = domainOf(address);
  const target = normalizePattern(domain);
  return !!d && (d === target || d.endsWith(`.${target}`));
}

export function ruleMatches(rule: SenderRule, address: string | null | undefined): boolean {
  if (!address) return false;
  return rule.scope === "address"
    ? normalizePattern(address) === normalizePattern(rule.pattern)
    : underDomain(address, rule.pattern);
}

/** Why a message can't key a rule, a note or a suggestion. */
export type KeyRefusal = "unchecked" | "platform" | "robot";

/**
 * The customer address an email gives us to key on (H3, G7, G3): where a reply to it goes.
 * Refused when we never read its Reply-To (the address would fall back to a form's robot),
 * when it's a lead site's relay (Thumbtack, Angi: one address for many customers), or when
 * it's an automatic address.
 */
export function keyFromMessage(m: {
  fromAddress: string | null;
  replyToHeader: ReplyToHeader | null;
}): { ok: true; key: string } | { ok: false; why: KeyRefusal } {
  if (m.replyToHeader === null) return { ok: false, why: "unchecked" };
  const key = normalizePattern(m.replyToHeader.address ?? m.fromAddress ?? "");
  if (!key || !domainOf(key)) return { ok: false, why: "robot" };
  if (leadPlatformOf(key)) return { ok: false, why: "platform" };
  if (isNoReplyAddress(key)) return { ok: false, why: "robot" };
  return { ok: true, key };
}

/** The company choice ("Anyone at hillpm.com"), or null where a company rule makes no sense. */
export function companyChoice(address: string, ownAddresses: readonly string[]): string | null {
  const d = domainOf(address);
  if (!d || PUBLIC_WEBMAIL_DOMAINS.has(d)) return null;
  // A carrier's email-to-text gateway (vtext.com…) is every texting customer of that carrier,
  // like webmail: never "Anyone at" one (leads + ideas merge).
  if (isEmailToTextAddress(address)) return null;
  const own = new Set(ownAddresses.map(domainOf).filter((x): x is string => !!x));
  if ([...own].some((o) => d === o || d.endsWith(`.${o}`) || o.endsWith(`.${d}`))) return null;
  return d;
}

export type RuleMatch = {
  /** Something adds caution: a VIP, or a company "Always needs me". */
  caution: "vip" | "needs_me" | null;
  /** "Never draft" matched (sender or reply address). */
  noDraft: boolean;
  /** "Always junk" matched, in the safe direction, and nothing adds caution. */
  junk: boolean;
};

export function matchRules(
  rules: readonly SenderRule[],
  m: {
    from: string | null;
    /** Where a reply goes (the stored Reply-To, else From). */
    replyAddress: string | null;
    /** reply_to_header as stored: null = never read. */
    replyToHeader: ReplyToHeader | null;
    vips: readonly string[];
  },
): RuleMatch {
  const either = (r: SenderRule) => ruleMatches(r, m.from) || ruleMatches(r, m.replyAddress);
  const vips = new Set(m.vips.map(normalizePattern));
  const vip = [m.from, m.replyAddress].some((a) => !!a && vips.has(normalizePattern(a)));
  const needsMe = rules.some((r) => r.action === "needs_me" && either(r));
  const caution = vip ? "vip" : needsMe ? "needs_me" : null;
  const redirected = !!m.replyToHeader?.address;
  const junkRule = rules.some(
    (r) =>
      r.action === "junk" &&
      m.replyToHeader !== null &&
      ruleMatches(r, m.from) &&
      (!redirected || ruleMatches(r, m.replyAddress)),
  );
  return {
    caution,
    noDraft: rules.some((r) => r.action === "no_draft" && either(r)),
    junk: junkRule && caution === null,
  };
}

/**
 * Words that keep an email out of the junk shortcut whatever the rule says: it goes to the
 * sorter as usual (a cost, never a risk). Whole words, any case.
 */
export const JUNK_GUARD_WORDS = [
  "lawyer",
  "attorney",
  "sue",
  "suing",
  "court",
  "small claims",
  "bbb",
  "better business bureau",
  "chargeback",
  "refund",
  "dispute",
  "cancel",
  "complaint",
  "unhappy",
  "damage",
  "damaged",
  "leak",
  "leaking",
  "emergency",
] as const;

const JUNK_GUARD = new RegExp(
  `(^|[^a-z0-9])(${JUNK_GUARD_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?=$|[^a-z0-9])`,
  "i",
);

export function junkShortcutBlocked(text: string): boolean {
  return JUNK_GUARD.test(text);
}

/** Why a rule wasn't saved — a code, with its plain sentence in RULE_REFUSALS. */
export type RuleRefusal =
  KeyRefusal | "webmail_company" | "municipal" | "known_customer" | "full" | "not_found";

export const RULE_REFUSALS: Record<RuleRefusal, string> = {
  unchecked: "We're still checking where this email came from. Try again later.",
  platform: "This is where your leads come from, so a rule could hide new customers.",
  robot: "This email came from an automatic address.",
  webmail_company: "Lots of different people use that kind of address, so pick just this address.",
  municipal: "Building departments always reach you.",
  known_customer:
    "You've written to them before (or they have an open quote or invoice), so we won't hide their email. Tap Never draft instead if you just don't want replies written.",
  full: `You have ${MAX_SENDER_RULES} rules. Remove one first.`,
  not_found: "That email isn't here any more. Refresh and try again.",
};

export const ACTION_WORDS: Record<OwnerSenderRuleAction, string> = {
  junk: "Always junk",
  no_draft: "Never draft",
  needs_me: "Always needs me",
};

/** The reason a company-wide "Always needs me" puts on an email. */
export const SENDER_NEEDS_ME_REASON = "You asked to see every email from this sender.";
