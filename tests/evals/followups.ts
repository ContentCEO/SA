/**
 * Follow-up nudge evals (wave 2, Prompt versions step 4: Check 21 P7 + Check 12 P7). Each case is
 * an invented quiet conversation (example.com addresses); the follow-up prompt (followup.v5) is
 * run with the real workspace and conversation blocks and scored: `skip` must match the key, a
 * written nudge stays under 60 words, repeats no dollar figure that isn't in the conversation,
 * uses no guilt phrase, and on an invoice offers no easy out (checkDraft's invoiceReminder).
 */
import { callStructured } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import { conversationBlock, workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v9";
import {
  FOLLOWUP_INSTRUCTIONS,
  FOLLOWUP_PROMPT_VERSION,
  followupSchema,
  followupTask,
  type FollowupKind,
  type FollowupSkip,
} from "@/ai/prompts/followup.v5";
import type { Trade } from "@/config/trades";

export type FollowupCase = {
  id: string;
  trade: Trade;
  kind: FollowupKind;
  nudgeNumber: 1 | 2;
  daysQuiet: number;
  customer: string;
  /** Oldest first. The owner's message is last unless the customer acknowledged it. */
  messages: { direction: "in" | "out"; body: string; daysAgo: number }[];
  /** Check 21 P1: the customer's newest email only acknowledged (the task names the day). */
  acknowledged?: boolean;
  expect: { skip: FollowupSkip | null };
};

const c = (x: FollowupCase) => x;

export const FOLLOWUP_CASES: FollowupCase[] = [
  c({
    id: "f-quiet-quote",
    trade: "electrical",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "Dana Ruiz",
    messages: [
      { direction: "in", body: "Can you quote a 200 amp panel upgrade? 1962 ranch.", daysAgo: 6 },
      {
        direction: "out",
        body: "Hi Dana, I can do the panel upgrade for $2,400 including the permit. Let me know if you'd like to book it.\n\nAlex",
        daysAgo: 3,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-quiet-invoice",
    trade: "plumbing",
    kind: "invoice",
    nudgeNumber: 1,
    daysQuiet: 5,
    customer: "Sam Lee",
    messages: [
      {
        direction: "in",
        body: "Thanks for the water heater swap, it's working great.",
        daysAgo: 12,
      },
      {
        direction: "out",
        body: "Glad to hear it. Invoice 318 for $1,450 is attached, due on receipt.\n\nAlex",
        daysAgo: 5,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-second-nudge-quote",
    trade: "carpentry",
    kind: "quote",
    nudgeNumber: 2,
    daysQuiet: 4,
    customer: "Priya Shah",
    messages: [
      {
        direction: "in",
        body: "A few deck boards are rotting and the railing is loose. Can you give me a number?",
        daysAgo: 12,
      },
      {
        direction: "out",
        body: "Hi Priya, the deck repair would be $1,850. Happy to come by if you want to go ahead.\n\nAlex",
        daysAgo: 9,
      },
      {
        direction: "out",
        body: "Hi Priya, just following up on the deck repair quote. Let me know if you have any questions.\n\nAlex",
        daysAgo: 4,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-second-nudge-invoice",
    trade: "roofing",
    kind: "invoice",
    nudgeNumber: 2,
    daysQuiet: 5,
    customer: "Ana Lopez",
    messages: [
      {
        direction: "out",
        body: "Hi Ana, invoice 77 for the roof repair ($3,200) is attached. Thanks again.\n\nAlex",
        daysAgo: 14,
      },
      {
        direction: "out",
        body: "Hi Ana, a quick reminder on invoice 77 for the roof repair. Let me know if you need it resent.\n\nAlex",
        daysAgo: 5,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-after-holidays",
    trade: "remodeling",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 4,
    customer: "Nina Cole",
    messages: [
      {
        direction: "out",
        body: "Hi Nina, the bathroom refresh comes to $9,800 as we discussed.\n\nAlex",
        daysAgo: 8,
      },
      { direction: "in", body: "Thanks! We'll get back to you after the holidays.", daysAgo: 7 },
      { direction: "out", body: "Sounds good, enjoy the holidays.\n\nAlex", daysAgo: 4 },
    ],
    expect: { skip: "asked_to_wait" },
  }),
  c({
    id: "f-went-elsewhere",
    trade: "hvac",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 4,
    customer: "Tom Baker",
    messages: [
      {
        direction: "out",
        body: "Hi Tom, the mini-split for the garage would be $4,100 installed.\n\nAlex",
        daysAgo: 9,
      },
      { direction: "in", body: "We went with someone else, thanks for your time.", daysAgo: 7 },
      { direction: "out", body: "No problem, thanks for letting me know.\n\nAlex", daysAgo: 4 },
    ],
    expect: { skip: "declined" },
  }),
  c({
    id: "f-paid-by-check",
    trade: "painting",
    kind: "invoice",
    nudgeNumber: 1,
    daysQuiet: 4,
    customer: "Chris Wu",
    messages: [
      {
        direction: "out",
        body: "Hi Chris, invoice 2210 for the bedrooms ($2,600) is attached.\n\nAlex",
        daysAgo: 10,
      },
      { direction: "in", body: "Paid by check yesterday, should reach you this week.", daysAgo: 6 },
      { direction: "out", body: "Great, thank you!\n\nAlex", daysAgo: 4 },
    ],
    expect: { skip: "paid" },
  }),
  c({
    id: "f-owner-asked-photos",
    trade: "plumbing",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "Lee Grant",
    messages: [
      {
        direction: "in",
        body: "Our 40 gallon tank is 14 years old and making noise. How much to replace it?",
        daysAgo: 5,
      },
      {
        direction: "out",
        body: "Hi Lee, happy to quote it. Could you send a photo of the label on the tank and the vent on top?\n\nAlex",
        daysAgo: 3,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-price-objection",
    trade: "landscaping",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "Ruth Adler",
    messages: [
      { direction: "out", body: "Hi Ruth, the paver patio comes to $7,400.\n\nAlex", daysAgo: 7 },
      {
        direction: "in",
        body: "That's more than we hoped. Is there a smaller version that would work?",
        daysAgo: 6,
      },
      {
        direction: "out",
        body: "Sure. A 10x12 patio instead of 12x16 would be around $5,200.\n\nAlex",
        daysAgo: 3,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-portuguese-customer",
    trade: "carpentry",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "João Pereira",
    messages: [
      {
        direction: "in",
        body: "Olá, gostaria de um orçamento para trocar a porta da frente.",
        daysAgo: 6,
      },
      {
        direction: "out",
        body: "Hi João, the front door replacement would be $1,650 installed.\n\nAlex",
        daysAgo: 3,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-gc-bid",
    trade: "electrical",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 4,
    customer: "Mark Doyle",
    messages: [
      {
        direction: "in",
        body: "We're bidding a 12-unit building on Elm. Can you price the electrical rough and finish from the attached plans?",
        daysAgo: 9,
      },
      {
        direction: "out",
        body: "Hi Mark, our bid for the electrical on the 12 units is $86,000, broken down in the attached sheet.\n\nAlex",
        daysAgo: 4,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-big-remodel",
    trade: "remodeling",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 7,
    customer: "Casey Doyle",
    messages: [
      {
        direction: "in",
        body: "We'd like to redo our kitchen: cabinets, counters, flooring, and move the sink to the island.",
        daysAgo: 20,
      },
      {
        direction: "out",
        body: "Hi Casey, the kitchen as we walked it comes to $48,500. The proposal is attached.\n\nAlex",
        daysAgo: 7,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-small-repair",
    trade: "plumbing",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "Jo Park",
    messages: [
      { direction: "in", body: "Can you fix a dripping bathroom faucet?", daysAgo: 5 },
      {
        direction: "out",
        body: "Hi Jo, a faucet repair is $150 for the visit plus any parts. Want me to come by?\n\nAlex",
        daysAgo: 3,
      },
    ],
    expect: { skip: null },
  }),
  c({
    id: "f-already-booked",
    trade: "hvac",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 3,
    customer: "Jen Moss",
    messages: [
      {
        direction: "out",
        body: "Hi Jen, the furnace tune-up is $160. Does Tuesday at 9 work?\n\nAlex",
        daysAgo: 6,
      },
      { direction: "in", body: "Tuesday at 9 is perfect, see you then.", daysAgo: 5 },
      { direction: "out", body: "Great, see you Tuesday.\n\nAlex", daysAgo: 3 },
    ],
    expect: { skip: "already_answered" },
  }),
  c({
    id: "f-acknowledged",
    trade: "roofing",
    kind: "quote",
    nudgeNumber: 1,
    daysQuiet: 4,
    customer: "Kim Nolan",
    messages: [
      {
        direction: "out",
        body: "Hi Kim, the roof replacement comes to $14,800 as quoted.\n\nAlex",
        daysAgo: 6,
      },
      {
        direction: "in",
        body: "Got it, thanks. We'll look it over and get back to you.",
        daysAgo: 4,
      },
    ],
    acknowledged: true,
    expect: { skip: null },
  }),
];

/** Guilt phrases a nudge must never use (Check 21 P7). */
export const GUILT_PHRASES = [
  "haven't heard",
  "it's been",
  "per my last",
  "just checking in",
  "just bumping",
];

const PROFILE: WorkspaceContext = {
  businessName: "Example Trades Co.",
  trade: "plumbing",
  services: null,
  serviceArea: null,
  hours: "Mon–Fri 7am–4pm",
  leadTime: null,
  pricingNotes: null,
  paymentTerms: "Due on receipt. Check or card.",
  policies: null,
  signature: "Alex",
  doNotPromise: [],
  neverSay: [],
  seasonalNotes: [],
  voice: null,
};

/** Every dollar figure in a text, as whole dollars. */
const dollars = (t: string) =>
  [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) =>
    Math.round(Number(m[1]!.replace(/,/g, ""))),
  );

export async function runFollowupEvals(
  workspaceId: string,
  now = new Date("2026-10-01T14:00:00Z"),
) {
  const problems: Record<string, string[]> = {};
  let skipRight = 0;
  let skipScored = 0;
  for (const f of FOLLOWUP_CASES) {
    const messages = f.messages.map((m) => ({
      from: m.direction === "out" ? "owner@example.com" : f.customer,
      direction: m.direction,
      sentAt: new Date(now.getTime() - m.daysAgo * 86_400_000),
      body: m.body,
    }));
    const last = messages.at(-1)!;
    const ctx = { ...PROFILE, trade: f.trade };
    const result = await callStructured({
      workspaceId,
      role: "draft",
      promptVersion: FOLLOWUP_PROMPT_VERSION,
      maxTokens: 2048,
      effort: "medium",
      system: [
        { text: FOLLOWUP_INSTRUCTIONS, cache: false },
        { text: workspaceBlock(ctx), cache: true },
      ],
      user: conversationBlock({
        now,
        subject: f.kind === "invoice" ? "Invoice" : "Quote",
        category: f.kind === "invoice" ? "invoice_payment" : "quote_request",
        summary: null,
        extracted: {},
        messages,
        task: followupTask({
          nudgeNumber: f.nudgeNumber,
          daysQuiet: f.daysQuiet,
          kind: f.kind,
          acknowledgedOn: f.acknowledged ? "Sunday, September 27" : null,
        }),
      }),
      schema: followupSchema,
    });
    const found: string[] = [];
    if (!result) found.push("no usable answer");
    else {
      skipScored++;
      if ((result.skip ?? null) === f.expect.skip) skipRight++;
      else found.push(`skip ${result.skip ?? "null"}, expected ${f.expect.skip ?? "null"}`);
      if (!result.skip) {
        const body = result.body.trim();
        if (!body) found.push("empty nudge");
        if (body.split(/\s+/).length > 60) found.push("over 60 words");
        const seen = new Set(messages.flatMap((m) => dollars(m.body)));
        for (const d of dollars(body)) if (!seen.has(d)) found.push(`invents $${d}`);
        for (const g of GUILT_PHRASES)
          if (body.toLowerCase().includes(g)) found.push(`says "${g}"`);
        const check = checkDraft(body, {
          sourceText: messages.map((m) => m.body).join("\n"),
          whenSourceText: messages.map((m) => m.body).join("\n"),
          doNotPromise: [],
          neverSay: [],
          phrasesAvoided: [],
          invoiceReminder: f.kind === "invoice",
        });
        found.push(...check.flags.filter((x) => x.includes("commit") || x.includes("easy out")));
      } else if (result.body.trim()) found.push("skip set but body written");
    }
    void last;
    if (found.length) problems[f.id] = found;
  }
  return {
    followupPassRate:
      FOLLOWUP_CASES.length === 0
        ? 1
        : Math.round(
            ((FOLLOWUP_CASES.length - Object.keys(problems).length) / FOLLOWUP_CASES.length) * 1000,
          ) / 1000,
    followupSkipAccuracy: skipScored === 0 ? 1 : Math.round((skipRight / skipScored) * 1000) / 1000,
    followupProblems: problems,
  };
}
