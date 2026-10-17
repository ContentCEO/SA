import { pricing } from "@/config/pricing";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { bodyRetentionDays } from "@/config/retention";
import { EARN_THRESHOLD, GRACE_MINUTES } from "@/config/rules";

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

export const features = [
  {
    title: "Sorts every email",
    body: "Quote requests, questions, scheduling, invoices, suppliers. Complaints and anything big are put in front of you, not answered.",
  },
  {
    title: "Writes like you",
    body: "It learns your greetings, sign-off and phrases from your sent mail. The drafts are written by AI, so you read each one. If a draft mentions a price, a day or a promise you didn't give it, it's flagged so you can check it before you send.",
  },
  {
    title: "Chases quiet quotes",
    body: "If a customer goes quiet on a quote or invoice, it drafts a friendly nudge. Two nudges at most per conversation — each one a draft that waits for your okay.",
  },
  {
    title: "Morning summary",
    body: "When you're set up, it sends one short email at the time you choose: what's waiting and what needs you. Skipped on quiet mornings.",
  },
  {
    title: "Autopilot, when you're ready",
    body: "Off by default. Earned one kind of email at a time, never for complaints or money, and every reply waits 10 minutes so you can stop it.",
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
