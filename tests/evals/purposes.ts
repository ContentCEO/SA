/**
 * Eval cases for purpose drafts (purpose.v1 on top of draft.v5; plan #26 #28 #29):
 * deposit details on an accepted quote, review requests, and the one closing question.
 * All text is invented. `paymentTerms` overrides the eval profile's terms for that case
 * (null = the owner wrote none down).
 */
import { callStructured } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  draftSchema,
  workspaceBlock,
  type WorkspaceContext,
} from "@/ai/prompts/draft.v6";
import {
  closingQuestionTask,
  DEPOSIT_GAP,
  depositTask,
  PURPOSE_PROMPT_VERSION,
  reviewRequestTask,
} from "@/ai/prompts/purpose.v1";
import { DRAFT_PROMPT_VERSION } from "@/ai/prompts/draft.v6";
import { ensureDepositGap } from "@/ai/purpose";
import type { Trade } from "@/config/trades";
import type { DraftPurpose } from "@/db/schema";

export type PurposeCase = {
  id: string;
  purpose: DraftPurpose;
  trade: Trade;
  messages: { direction: "in" | "out"; from: string; body: string; daysAgo: number }[];
  /** Overrides the profile's payment terms; null = none written down. */
  paymentTerms?: string | null;
  mustContain?: string[];
  mustNotContain?: string[];
  /** No dollar figure that isn't in the conversation or the profile. */
  noInventedMoney?: boolean;
};

export const EVAL_REVIEW_URL = "https://example.com/review";

const QUOTE =
  "Hi Sam,\n\nThanks for having me out. The new vanity, faucet and shutoffs come to $1,450, parts and labor.\n\nThanks,\nAlex";

export const PURPOSE_CASES: PurposeCase[] = [
  {
    id: "dep-terms-card",
    purpose: "deposit",
    trade: "plumbing",
    messages: [
      { direction: "in", from: "Sam Lee", body: "Can you quote a vanity swap?", daysAgo: 6 },
      { direction: "out", from: "owner", body: QUOTE, daysAgo: 4 },
      {
        direction: "in",
        from: "Sam Lee",
        body: "Let's do it. What do you need from me?",
        daysAgo: 0,
      },
    ],
    mustContain: ["card"],
    noInventedMoney: true,
  },
  {
    id: "dep-terms-percent",
    purpose: "deposit",
    trade: "carpentry",
    paymentTerms: "50% deposit to book, by check or Zelle",
    messages: [
      { direction: "in", from: "Pat Kim", body: "Could you quote new porch steps?", daysAgo: 9 },
      {
        direction: "out",
        from: "owner",
        body: "Hi Pat,\n\nNew pressure-treated steps with rails: $2,200.\n\nAlex",
        daysAgo: 7,
      },
      {
        direction: "in",
        from: "Pat Kim",
        body: "Sounds good, go ahead and book us in.",
        daysAgo: 0,
      },
    ],
    mustContain: ["50%"],
    mustNotContain: ["venmo", "paypal", "discount"],
    noInventedMoney: true,
  },
  {
    id: "dep-no-terms",
    purpose: "deposit",
    trade: "electrical",
    paymentTerms: null,
    messages: [
      { direction: "in", from: "Jordan Fox", body: "Quote for a 200 amp panel?", daysAgo: 8 },
      {
        direction: "out",
        from: "owner",
        body: "Hi Jordan,\n\nThe panel upgrade is $3,100 including the permit.\n\nAlex",
        daysAgo: 5,
      },
      {
        direction: "in",
        from: "Jordan Fox",
        body: "We're in. Let's get it scheduled.",
        daysAgo: 0,
      },
    ],
    mustContain: [DEPOSIT_GAP],
    mustNotContain: ["%", "zelle", "venmo"],
    noInventedMoney: true,
  },
  {
    id: "dep-no-terms-customer-asks",
    purpose: "deposit",
    trade: "painting",
    paymentTerms: null,
    messages: [
      { direction: "in", from: "Riley Moss", body: "Quote to paint two bedrooms?", daysAgo: 7 },
      {
        direction: "out",
        from: "owner",
        body: "Hi Riley,\n\nBoth bedrooms, walls and trim: $1,200.\n\nAlex",
        daysAgo: 5,
      },
      {
        direction: "in",
        from: "Riley Moss",
        body: "Great, let's do it. How much is the deposit, and can I pay it by Venmo?",
        daysAgo: 0,
      },
    ],
    mustContain: [DEPOSIT_GAP],
    // The customer asked about Venmo; with no terms on file the draft must not agree to it.
    mustNotContain: ["%", "discount", "venmo"],
    noInventedMoney: true,
  },
  {
    id: "rev-happy",
    purpose: "review_request",
    trade: "hvac",
    messages: [
      {
        direction: "out",
        from: "owner",
        body: "All done — the new thermostat is set.",
        daysAgo: 2,
      },
      {
        direction: "in",
        from: "Casey Park",
        body: "Works great, the house is finally warm. Thanks!",
        daysAgo: 1,
      },
    ],
    mustContain: [EVAL_REVIEW_URL],
    mustNotContain: ["discount", "gift card", "coupon", "% off"],
  },
  {
    id: "rev-after-paid",
    purpose: "review_request",
    trade: "landscaping",
    messages: [
      {
        direction: "in",
        from: "Morgan Hale",
        body: "Paid the invoice — the yard looks great.",
        daysAgo: 3,
      },
      { direction: "out", from: "owner", body: "Got it, thank you Morgan!", daysAgo: 2 },
    ],
    mustContain: [EVAL_REVIEW_URL],
    mustNotContain: ["discount", "gift card", "coupon"],
  },
  {
    id: "close-quiet-quote",
    purpose: "closing_question",
    trade: "roofing",
    messages: [
      { direction: "in", from: "Drew Tan", body: "Can you quote a roof patch?", daysAgo: 30 },
      {
        direction: "out",
        from: "owner",
        body: "Hi Drew,\n\nThe patch and new flashing is $850.\n\nAlex",
        daysAgo: 25,
      },
      { direction: "out", from: "owner", body: "Hi Drew, any thoughts on the quote?", daysAgo: 20 },
      {
        direction: "out",
        from: "owner",
        body: "Hi Drew, no rush — still here if you need us.",
        daysAgo: 12,
      },
    ],
    mustNotContain: ["$", "guarantee", "discount", "just checking in", "following up"],
    noInventedMoney: true,
  },
];

const PROFILE: Omit<WorkspaceContext, "trade" | "paymentTerms"> = {
  businessName: "Example Trades Co.",
  services: "Residential repairs and installs",
  serviceArea: "Around Springfield",
  hours: "Mon–Fri 7am–4pm",
  leadTime: "About two weeks out",
  pricingNotes: null,
  policies: null,
  signature: "Thanks,\nAlex",
  doNotPromise: ["same-day service"],
  neverSay: ["no problem at all"],
  seasonalNotes: [],
  voice: null,
};
/** The eval profile's terms when a case doesn't override them (as in run.ts). */
export const DEFAULT_PAYMENT_TERMS = "Due on completion; check or card";

const AT = new Date("2026-10-01T14:00:00Z");

export async function runPurposeEvals(workspaceId: string) {
  let passed = 0;
  const purposeProblems: Record<string, string[]> = {};
  for (const c of PURPOSE_CASES) {
    const ctx: WorkspaceContext = {
      ...PROFILE,
      trade: c.trade,
      paymentTerms: c.paymentTerms === undefined ? DEFAULT_PAYMENT_TERMS : c.paymentTerms,
    };
    const lastOut = [...c.messages].reverse().find((m) => m.direction === "out");
    const task =
      c.purpose === "deposit"
        ? depositTask({ paymentTerms: ctx.paymentTerms })
        : c.purpose === "review_request"
          ? reviewRequestTask({ reviewUrl: EVAL_REVIEW_URL })
          : closingQuestionTask({ daysQuiet: Math.max(1, lastOut?.daysAgo ?? 7) });
    const r = await callStructured({
      workspaceId,
      role: "draft",
      promptVersion: `${DRAFT_PROMPT_VERSION}+${PURPOSE_PROMPT_VERSION}`,
      maxTokens: 2048,
      effort: "medium",
      system: [
        { text: DRAFT_INSTRUCTIONS, cache: false },
        { text: workspaceBlock(ctx), cache: true },
      ],
      user: conversationBlock({
        subject: "Your quote",
        category: c.purpose === "review_request" ? "customer_question" : "quote_request",
        summary: null,
        extracted: null,
        task,
        messages: c.messages.map((m) => ({
          from: m.direction === "out" ? "owner@example.com" : m.from,
          direction: m.direction,
          sentAt: new Date(AT.getTime() - m.daysAgo * 86_400_000),
          body: m.body,
        })),
      }),
      schema: draftSchema,
    });
    const problems: string[] = [];
    if (!r || !r.body.trim()) problems.push("no usable draft");
    else {
      // What createDraftForThread does after the model, so the eval scores what the owner sees.
      const body =
        c.purpose === "deposit" && !ctx.paymentTerms?.trim()
          ? ensureDepositGap(r.body.trim())
          : r.body.trim();
      const lower = body.toLowerCase();
      for (const m of c.mustContain ?? [])
        if (!lower.includes(m.toLowerCase())) problems.push(`missing "${m}"`);
      for (const m of c.mustNotContain ?? [])
        if (lower.includes(m.toLowerCase())) problems.push(`says "${m}"`);
      const check = checkDraft(body, {
        sourceText: [...c.messages.map((m) => m.body), ctx.hours, ctx.leadTime, ctx.paymentTerms]
          .filter(Boolean)
          .join("\n"),
        doNotPromise: ctx.doNotPromise,
        neverSay: ctx.neverSay,
        phrasesAvoided: [],
        checkTerms: c.purpose !== "closing_question",
        // As createDraftForThread: terms come from the owner only, never the customer (A4).
        termsSource:
          c.purpose === "deposit"
            ? [ctx.paymentTerms, ctx.policies, ctx.pricingNotes].filter(Boolean).join("\n")
            : "",
        ownerWrote:
          c.purpose === "deposit"
            ? c.messages
                .filter((m) => m.direction === "out")
                .map((m) => m.body)
                .join("\n")
            : "",
        review: c.purpose === "review_request" ? { url: EVAL_REVIEW_URL } : undefined,
      });
      if (c.noInventedMoney) problems.push(...check.flags.filter((f) => f.includes("price")));
      problems.push(
        ...check.flags.filter((f) =>
          /never-promise|never-say|stand behind|payment terms|review request never|review link/.test(
            f,
          ),
        ),
      );
    }
    if (problems.length) purposeProblems[c.id] = problems;
    else passed++;
  }
  return {
    purposePassRate: Math.round((passed / PURPOSE_CASES.length) * 1000) / 1000,
    purposeProblems,
  };
}
