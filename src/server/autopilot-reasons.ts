/**
 * Check 20 P7: why autopilot didn't send, as short content-free codes. The codes may be
 * stored (drafts.autopilot_skip) and logged (autopilot_skipped / autopilot_stood_down):
 * they are fixed words chosen here, never email text. Pure: no database, no server-only.
 */
import { categoryLabels } from "@/config/categories";
import {
  DAILY_AUTOPILOT_CAP,
  EARN_THRESHOLD,
  GRACE_MINUTES,
  MIN_CONFIDENCE_PCT,
} from "@/config/rules";

/** Per-email guardrails (layer 3), in the order guardrailReasons checks them. */
export const GUARDRAIL_CODES = [
  "other_kind",
  "needs_owner",
  "followup",
  "low_confidence",
  "flags",
  "invoice_amount",
  "money",
  "gaps",
  "not_known",
  "untrusted",
  "municipal",
  "utility",
  "crew",
  "accepts_quote",
  "purpose",
  "maybe_answered",
  "redirected",
  "reply_to_unchecked",
  "complained",
  "payment_change",
  "legal",
  "unreadable",
  "gas",
  "co_alarm",
  "asks_if_ai",
  "injection_cleared",
  "electrical",
  "recent_emergency",
  "owner_moved",
  "lead_channel",
  "text_address",
  "first_reply",
  "auto_reply",
  "other_language",
  "new_person",
] as const;
export type GuardrailCode = (typeof GUARDRAIL_CODES)[number];

/** Reasons outside the per-email layer: the account, the switch, the cap, the last check. */
export const RUN_CODES = [
  "account_locked",
  "mailbox_paused",
  "autopilot_off",
  "daily_cap",
  "newer_mail",
  "writing_in_gmail",
  "stale_timing",
  "left_inbox",
  "cant_send",
] as const;
export type RunCode = (typeof RUN_CODES)[number];
export type AutopilotReasonCode = GuardrailCode | RunCode;

const ALL_CODES: readonly string[] = [...GUARDRAIL_CODES, ...RUN_CODES];
export function isAutopilotReasonCode(c: unknown): c is AutopilotReasonCode {
  return typeof c === "string" && ALL_CODES.includes(c);
}

/** The full sentence for each per-email guardrail (what runAutopilotSend reports). */
export const GUARDRAIL_LINES: Record<GuardrailCode, string> = {
  other_kind: "Complaints and other emails always wait for you.",
  needs_owner: "Flagged as needing you.",
  followup: "Follow-ups always wait for you.",
  low_confidence: "Not confident enough to send alone.",
  flags: "Has things to check before sending.",
  invoice_amount: "Payments with an amount always wait for you.",
  money: "Mentions money, so it waits for you.",
  gaps: "Has gaps for you to fill in.",
  not_known: "You haven't written to this person before.",
  untrusted: "This email tried to give instructions to the assistant.",
  municipal: "Building departments always wait for you.",
  utility: "The electric company always waits for you.",
  crew: "Emails to your crew always wait for you.",
  accepts_quote: "Quote acceptances always wait for you.",
  purpose: "Deposit, review and closing notes always wait for you.",
  maybe_answered: "You might already have answered this in Gmail.",
  redirected: "This reply goes to a different address than the sender's, so it waits for you.",
  reply_to_unchecked: "We couldn't check where this reply goes, so it waits for you.",
  complained: "This customer complained in the last 12 months, so it waits for you.",
  payment_change: "Asks to pay a new account, so it waits for you.",
  legal: "Something legal is mentioned in this conversation, so it waits for you.",
  unreadable: "We can't read their email any more, so it waits for you.",
  gas: "Someone smells gas. Call them.",
  co_alarm: "A carbon monoxide alarm went off. Call them.",
  asks_if_ai: "Asks if a person is answering, so it waits for you.",
  injection_cleared: "You said an email here was normal after we flagged it, so it waits for you.",
  electrical: "Sounds like an electrical fire risk. Call them.",
  recent_emergency:
    "There was an emergency on this conversation in the last 2 days, so it waits for you.",
  owner_moved: "You chose this kind yourself, so it waits for you.",
  lead_channel: "Lead-site and voicemail emails always wait for you.",
  text_address: "That address may turn into a text message, so it waits for you.",
  first_reply: "First replies to new customers always wait for you.",
  auto_reply: "That was an automatic reply, so it waits for you.",
  other_language: "Not in English, so it waits for you.",
  new_person: "Someone new is on this conversation, so it waits for you.",
};

/**
 * Short words for the queue card ("Autopilot is on for scheduling, but this one waits: …")
 * and Activity ("Autopilot didn't send the reply to Dana: …"). Lower case, no full stop.
 */
export const REASON_PHRASES: Record<AutopilotReasonCode, string> = {
  other_kind: "this kind of email always waits for you",
  needs_owner: "it's flagged as needing you",
  followup: "follow-ups always wait for you",
  low_confidence: `it was less than ${MIN_CONFIDENCE_PCT}% sure of the reply`,
  flags: "the reply has things to check",
  invoice_amount: "their email has an amount in it",
  money: "the reply mentions money",
  gaps: "the reply has gaps to fill in",
  not_known: "you haven't written to this address before",
  untrusted: "their email tried to give the assistant instructions",
  municipal: "it's from a building department",
  utility: "it's from the electric company",
  crew: "it goes to your crew",
  accepts_quote: "they're accepting a quote",
  purpose: "deposit, review and thank-you notes always wait for you",
  maybe_answered: "you might already have answered in Gmail",
  redirected: "the reply goes to a different address than the sender's",
  reply_to_unchecked: "we couldn't check where the reply goes",
  complained: "this customer complained in the last 12 months",
  payment_change: "they asked to pay a new account",
  legal: "something legal is mentioned",
  unreadable: "we can't read their email any more",
  gas: "someone smells gas",
  co_alarm: "a carbon monoxide alarm went off",
  asks_if_ai: "they asked if a person is answering",
  injection_cleared: "an email here was flagged before",
  electrical: "it sounds like an electrical fire risk",
  recent_emergency: "there was an emergency here in the last 2 days",
  owner_moved: "you chose this kind yourself",
  lead_channel: "it came from a lead site or a voicemail",
  text_address: "the address may turn into a text message",
  first_reply: "it's a first reply to a new customer",
  auto_reply: "their email was an automatic reply",
  other_language: "it isn't in English",
  new_person: "someone new is on the conversation",
  account_locked: "autopilot isn't open on your account right now",
  mailbox_paused: "this Gmail address is paused on your plan",
  autopilot_off: "autopilot is off for this kind of email",
  daily_cap: `autopilot already lined up ${DAILY_AUTOPILOT_CAP} replies in the last 24 hours`,
  newer_mail: "new mail came in on the conversation",
  writing_in_gmail: "you're writing a reply in Gmail",
  stale_timing: "its day or time words are out of date",
  left_inbox: "the conversation left your inbox in Gmail",
  cant_send: "sending isn't switched on for this account",
};

/** Stored codes → the codes we know, in order, without repeats (anything else is dropped). */
export function knownReasonCodes(raw: unknown): AutopilotReasonCode[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isAutopilotReasonCode))];
}

/** The queue card's line for a reply in a switched-on kind that waits. */
export function autopilotWaitLine(kindLabel: string, raw: unknown): string | null {
  const [first] = knownReasonCodes(raw);
  if (!first) return null;
  return `Autopilot is on for ${kindLabel.toLowerCase()}, but this one waits: ${REASON_PHRASES[first]}.`;
}

/**
 * Check 20 P6: Settings → Autopilot, one rule per line, generated from the same codes the
 * guardrails use so the screen can't drift from the code. Every GuardrailCode must appear in
 * exactly one line (tested); run codes appear where the owner would expect them.
 */
export type SettingsLine = { text: string; codes: readonly AutopilotReasonCode[] };

/** "It sends on its own only when all of these are true:" */
export const AUTOPILOT_WHEN_LINES: readonly SettingsLine[] = [
  {
    text: `You turned it on for that kind of email, after ${EARN_THRESHOLD} replies you sent without changing them.`,
    codes: ["autopilot_off", "account_locked", "mailbox_paused", "cant_send"],
  },
  { text: "You've written to this person before.", codes: ["not_known"] },
  {
    text: "It goes to the address the email came from.",
    codes: ["redirected", "reply_to_unchecked"],
  },
  { text: `It's at least ${MIN_CONFIDENCE_PCT}% sure of the reply.`, codes: ["low_confidence"] },
  { text: "Nothing to check and no gaps to fill in.", codes: ["flags", "gaps"] },
  { text: "No price or amount anywhere in the reply.", codes: ["money"] },
  {
    text: `For ${categoryLabels.invoice_payment}: only when the email has no amount, like "Did you get my check?"`,
    codes: ["invoice_amount"],
  },
  { text: "The email and the reply are in English.", codes: ["other_language"] },
  { text: "Nobody new is on the conversation.", codes: ["new_person"] },
  {
    text: "No newer mail came in, and you're not writing a reply in Gmail.",
    codes: ["newer_mail", "writing_in_gmail", "maybe_answered"],
  },
  { text: "The conversation is still in your Gmail inbox.", codes: ["left_inbox"] },
  { text: "Its day and time words still make sense when it goes.", codes: ["stale_timing"] },
  { text: `At most ${DAILY_AUTOPILOT_CAP} in any 24 hours.`, codes: ["daily_cap"] },
  {
    text: `Each one waits ${GRACE_MINUTES} minutes in your queue with Hold it.`,
    codes: [],
  },
];

/** "It never sends:" */
export const AUTOPILOT_NEVER_LINES: readonly SettingsLine[] = [
  { text: "Complaints or junk.", codes: ["other_kind"] },
  { text: "Anything flagged as needing you.", codes: ["needs_owner"] },
  { text: "Follow-ups.", codes: ["followup"] },
  { text: "First replies to new customers.", codes: ["first_reply"] },
  { text: "Replies to an automatic reply or a bounce.", codes: ["auto_reply"] },
  { text: "Replies to someone accepting a quote.", codes: ["accepts_quote"] },
  { text: "Deposit, review, thank-you or closing notes.", codes: ["purpose"] },
  {
    text: "Replies to anyone who complained in the last 12 months.",
    codes: ["complained"],
  },
  { text: "Emails asking to pay a new account.", codes: ["payment_change"] },
  {
    text: "Anything with a lawyer, a lien or small claims in the conversation.",
    codes: ["legal"],
  },
  {
    text: "A gas smell, a carbon monoxide alarm or an electrical fire risk.",
    codes: ["gas", "co_alarm", "electrical"],
  },
  {
    text: "Anything on a conversation with an emergency in the last 2 days.",
    codes: ["recent_emergency"],
  },
  { text: "Emails from building departments.", codes: ["municipal"] },
  { text: "Emails from the electric company.", codes: ["utility"] },
  { text: "Emails to your crew.", codes: ["crew"] },
  { text: "Emails that try to give the assistant instructions.", codes: ["untrusted"] },
  {
    text: "Anything on a conversation you said was normal after we flagged it, for 30 days.",
    codes: ["injection_cleared"],
  },
  {
    text: "Replies when someone asks if a person is answering.",
    codes: ["asks_if_ai"],
  },
  { text: "Emails you moved to a different kind yourself.", codes: ["owner_moved"] },
  { text: "Lead-site, voicemail or text-message emails.", codes: ["lead_channel"] },
  {
    text: "Replies to an address that may turn into a text message.",
    codes: ["text_address"],
  },
  { text: "Replies to an email we can no longer read.", codes: ["unreadable"] },
];
