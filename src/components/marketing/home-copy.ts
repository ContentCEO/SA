import { pricing } from "@/config/pricing";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { bodyRetentionDays } from "@/config/retention";
import { EARN_THRESHOLD, GRACE_MINUTES } from "@/config/rules";
import { QUOTE_STAGES, stageLabel } from "@/server/quote-rules";

/**
 * The homepage's words (src/app/page.tsx renders them). Kept in a pure module so tests read the
 * strings as visitors see them, with every rule number taken from the code that enforces it.
 */

export const steps = [
  {
    n: "1",
    title: "Connect your Gmail",
    body: "We show you exactly what Squared Away can and can't do before Google asks for permission.",
  },
  {
    n: "2",
    title: "It sorts and drafts",
    body: "Every email is sorted — quote, question, scheduling, invoice, complaint, junk — and replies are written in your own words, as real Gmail drafts.",
  },
  {
    n: "3",
    title: "You tap Send reply",
    body: "Read it, change it if you like, send it. From the truck, between jobs, one-handed.",
  },
];

/** "waiting on you, quoted, gone quiet, won, lost or no answer", as the Quotes screen names them. */
function stageWords(): string {
  const words = QUOTE_STAGES.map((s) => stageLabel[s].toLowerCase());
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/**
 * "What it does, all day." Nine cards at most (Check 34 P2): what a trade inbox tool does first
 * (Check 34 P2), then the everyday work, then the lists (Check 6 P5), then the data promise.
 * Present tense only for what is live: phone alerts wait on their keys, so they aren't a card.
 * Autopilot's rules are on the page three more times (the first FAQ, the plan cards and the
 * pricing paragraph), so it has no card of its own.
 */
export const features = [
  {
    title: "Knows your trade",
    // trades/<trade>.ts "Before quoting, find out"; draft prompt's price-list rule, with
    // checkDraft flagging any other figure; looksMunicipal / the classifier's building-department
    // signal keep town mail out of junk (src/ai/guards.ts).
    body: "Asks the questions your trade needs before a quote, quotes prices from your price list as written and flags any other figure, and keeps permit and inspection emails from the town out of junk.",
  },
  {
    title: "Won't take orders from strangers",
    // injectionCheck (before the model) or the classifier's signal → needs you, and no draft
    // unless you tap Draft a reply; autopilot refuses it.
    body: "If an email looks like it's trying to tell the assistant what to do, it's held for you and never answered on its own.",
  },
  {
    title: "Sorts every email",
    body: "Quote requests, questions, scheduling, invoices, suppliers. Complaints and anything big are put in front of you, not answered. When you're set up, one short morning email at the time you choose says what's waiting and what needs you.",
  },
  {
    title: "Writes like you",
    body: "It learns your greetings, sign-off and phrases from your sent mail. The drafts are written by AI, so you read each one. If a draft mentions a price, a day or a promise you didn't give it, it's flagged so you can check it before you send.",
  },
  {
    title: "Chases quiet quotes",
    // Check 34 P3: followups.ts only nudges a thread where the customer emailed and the owner
    // replied last from this Gmail. "I called them" (queue/called-them.tsx) stops the nudges.
    body: "If a customer who emailed you goes quiet after you email back a quote or an invoice, it drafts a friendly nudge, two at most, each one waiting for your okay. Quotes sent from other software are left to that software. Called them instead? Tap I called them and it stops chasing.",
  },
  {
    title: "Every quote in one list",
    // The stage names the Quotes screen shows (stageLabel); totals on /quotes.
    body: `Each quote request and where it stands: ${stageWords()}. Mark how each one ended and your totals add up.`,
  },
  {
    title: "Who owes you",
    // /money: invoices a customer email mentions, amount and due date when the email gives them.
    body: "Invoices your customers' emails mention, with the amount and due date when they give them, so you can see what's still unpaid.",
  },
  {
    title: "Your customers, in one place",
    // /customers: everyone who emailed the business (junk left out), conversations together.
    body: "Everyone who has emailed your business, with their conversations together.",
  },
  {
    title: "Your data stays yours",
    // Check 6 P2: the purge removes bodies (and snippets, and draft text); who, when, subject
    // and summaries stay until disconnect, as the privacy policy says.
    body: `The body of each email is deleted after ${bodyRetentionDays()} days. We keep who wrote, when, the subject and a short summary so your lists keep working. Your email is only used to run the app for you, never to train AI. Disconnect any time.`,
  },
];

export const faqs = [
  {
    q: "Will it send emails without me?",
    // Check 6 P3: autopilot needs a plan with it, the setup call done, and replies sent exactly
    // as drafted (src/server/autopilot.ts).
    a: `No. Every reply waits in your queue until you tap Send reply. Autopilot is the one exception, and you choose it: it's only on the ${pricing.plans.crew.name} and ${pricing.plans.company.name} plans, only after your setup call, and only for a kind of email where you've sent ${EARN_THRESHOLD} replies without changing a word. Even then, each one waits ${GRACE_MINUTES} minutes so you can stop it.`,
  },
  {
    q: "Do I have to change how I do email?",
    // Check 34 P6: it isn't a Gmail add-on; replies are read and sent in our queue.
    a: "No. You keep your Gmail address, your folders and your Gmail app. You read and send replies in the Squared Away queue, on your phone or computer, and each draft is also saved in your Gmail Drafts folder so you can read it there too.",
  },
  {
    q: "Can it see all my email?",
    // Check 6 P2: gmail.compose lets it remove the drafts it wrote, nothing else.
    a: `It has permission to read your Gmail. When you connect, it reads the last 30 days of your email (the text only for your inbox), then new mail as it arrives, and up to 200 of your sent emails from the last year to learn how you write. It deletes the body of each email after ${bodyRetentionDays()} days. It has no permission to delete, archive or move your emails. The only thing it removes is a draft it wrote, when that draft is out of date or you tap Discard.`,
  },
  {
    q: "Does it work with Outlook?",
    a: "Gmail only for now, including Google Workspace. Outlook is on the list — join the waitlist anyway.",
  },
  {
    q: "What does the trial look like?",
    a: "Three days with your real inbox. It sorts and drafts so you can judge the replies — Squared Away won't send anything to a customer during the trial. Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want. If it's not for you, disconnect and you're done.",
  },
  {
    q: "What if I stop?",
    a: "Disconnect Gmail in Settings and our access is removed at Google straight away. Want it all gone? Delete my account in Settings deletes your account and everything in it from Squared Away, after one confirmation. Stripe keeps its own payment records. Month to month, no contract.",
  },
];

/**
 * The charcoal promise band (Check 6 P7): short sentences, the undo window from its constant,
 * autopilot named as the one exception, and Davi's trial words (2026-10-16) unchanged.
 */
export const promiseBand = [
  "Squared Away drafts. You decide.",
  `Every reply sits in your queue until you tap Send reply, and you have ${UNDO_WINDOW_SECONDS} seconds to take it back.`,
  "The only exception is autopilot, and only if you turn it on.",
  "During your three-day trial, Squared Away won't send anything to a customer.",
  "Its Send reply is switched off in the code, not just hidden behind a button.",
  "Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want.",
];
