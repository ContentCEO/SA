/**
 * Runs the evaluation set through the real pipeline functions (classifyEmail,
 * the drafting prompt, checkDraft) against an in-memory database. The model is
 * whatever transport is set: live Anthropic for `pnpm eval`, a fake in tests.
 */
import { sum } from "drizzle-orm";
import { classifyEmail } from "@/ai/classify";
import { callStructured } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import { asksWhenAvailable } from "@/ai/when-words";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  FIRST_CONTACT_TASK,
  replyDraftSchema,
  workspaceBlock,
} from "@/ai/prompts/draft.v7";
import { ACTIVE } from "@/ai/prompts/registry";
import { usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createTestDb } from "../support/db";
import type { EvalCase } from "./cases";
import { runEditEvals } from "./edits";
import { DEFAULT_PAYMENT_TERMS, runPurposeEvals } from "./purposes";
import { score, type EvalResult } from "./score";

/** The prompt versions an eval run used (stored with the baseline). */
export const PROMPT_VERSIONS: Record<string, string> = { ...ACTIVE };

/** A neutral, invented business so drafts have something to work from — and no prices. */
const PROFILE = {
  businessName: "Example Trades Co.",
  services: "Residential repairs and installs",
  serviceArea: "Around Springfield",
  hours: "Mon–Fri 7am–4pm",
  leadTime: "About two weeks out",
  pricingNotes: null,
  paymentTerms: DEFAULT_PAYMENT_TERMS,
  policies: null,
  signature: "Thanks,\nAlex",
  doNotPromise: ["same-day service"],
  neverSay: ["no problem at all"],
  seasonalNotes: [] as { text: string; endsOn: string }[],
};

export async function runEvals(
  cases: EvalCase[],
  opts: { drafts?: boolean; onProgress?: (done: number, total: number) => void } = {},
) {
  process.env.AI_DAILY_CALL_CAP = "100000";
  const database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "evals@example.com" });
  const results: EvalResult[] = [];
  let done = 0;

  for (const c of cases) {
    const email = {
      fromName: c.fromName,
      fromAddress: c.fromAddress,
      subject: c.subject,
      receivedAt: new Date("2026-10-01T14:00:00Z"),
      firstTimeSender: c.firstTimeSender ?? false,
      threadSummary: c.threadSummary ?? null,
      body: c.body,
    };
    const r = await classifyEmail(
      workspace.id,
      {
        businessName: PROFILE.businessName,
        trade: c.trade,
        amountThresholdDollars: 2500,
        vipSenders: [],
      },
      email,
      { senderIsVip: false },
    );
    const result: EvalResult = {
      id: c.id,
      category: r.category,
      needsOwner: r.needsOwner,
      priority: r.priority,
      injection: r.extracted.injection === true,
      municipal: r.extracted.municipal === true,
      permitResult: r.extracted.permit?.result ?? null,
      invoiceStatus: r.extracted.invoice?.status ?? null,
      acceptsQuote: r.extracted.accepts_quote === true,
      jobDone: r.extracted.job_done === true,
      paymentChange: r.extracted.payment_change === true,
      gasSmell: r.extracted.gas_smell === true,
      onMoneyOwed:
        r.category === "invoice_payment" && r.extracted.invoice_direction !== "owed_by_business",
      disputed: r.extracted.disputed === true,
    };

    if (opts.drafts !== false && c.draft) {
      const ctx = { ...PROFILE, trade: c.trade, voice: null };
      const draft = await callStructured({
        workspaceId: workspace.id,
        role: "draft",
        promptVersion: DRAFT_PROMPT_VERSION,
        maxTokens: 2048,
        effort: "medium",
        system: [
          { text: DRAFT_INSTRUCTIONS, cache: false },
          { text: workspaceBlock(ctx), cache: true },
        ],
        user: conversationBlock({
          now: email.receivedAt,
          subject: c.subject,
          category: r.category,
          summary: r.summary,
          extracted: r.extracted,
          // draft.v7: a first contact gets the task line the app sends (replies package).
          task: c.firstContact ? FIRST_CONTACT_TASK : undefined,
          messages: [{ from: c.fromName, direction: "in", sentAt: email.receivedAt, body: c.body }],
        }),
        schema: replyDraftSchema,
      });
      const problems: string[] = [];
      if (!draft) problems.push("no usable draft");
      else {
        const check = checkDraft(draft.body, {
          sourceText: [c.body, workspaceBlock(ctx)].join("\n"),
          // Check 20 P1 / 23 P3: days and times come from the conversation; the hours' days
          // only when the customer asked when the owner is open, as in the app.
          whenSourceText: c.body,
          hoursText: PROFILE.hours,
          leadTimeText: PROFILE.leadTime,
          allowHours: asksWhenAvailable(c.body),
          doNotPromise: PROFILE.doNotPromise,
          neverSay: PROFILE.neverSay,
          phrasesAvoided: [],
        });
        if (c.draft.noInventedMoney)
          problems.push(...check.flags.filter((f) => f.includes("price")));
        if (c.draft.noInventedDates)
          problems.push(...check.flags.filter((f) => f.includes("commit")));
        problems.push(
          ...check.flags.filter(
            (f) =>
              f.includes("never-promise") || f.includes("never-say") || f.includes("stand behind"),
          ),
        );
        for (const bad of c.draft.mustNotContain ?? []) {
          if (draft.body.toLowerCase().includes(bad.toLowerCase())) problems.push(`says "${bad}"`);
        }
        for (const good of c.draft.mustContain ?? []) {
          if (!draft.body.toLowerCase().includes(good.toLowerCase()))
            problems.push(`missing "${good}"`);
        }
        // The shape the drafter picked: first contacts' own, "not_first" for everything else.
        result.opening = draft.opening;
      }
      result.draftProblems = problems;
    }
    results.push(result);
    opts.onProgress?.(++done, cases.length);
  }

  const scores = score(cases, results);
  let reviseProblems: Record<string, string[]> = {};
  let purposeProblems: Record<string, string[]> = {};
  if (opts.drafts !== false) {
    const edits = await runEditEvals(workspace.id);
    scores.revisePassRate = edits.revisePassRate;
    scores.toneAccuracy = edits.toneAccuracy;
    reviseProblems = edits.reviseProblems;
    const purposes = await runPurposeEvals(workspace.id);
    scores.purposePassRate = purposes.purposePassRate;
    purposeProblems = purposes.purposeProblems;
  }

  const [cost] = await database
    .select({ centiCents: sum(usage.estimatedCostCentiCents).mapWith(Number) })
    .from(usage);
  const [tokens] = await database
    .select({
      in: sum(usage.modelTokensIn).mapWith(Number),
      out: sum(usage.modelTokensOut).mapWith(Number),
    })
    .from(usage);
  return {
    results,
    scores,
    reviseProblems,
    purposeProblems,
    costDollars: (cost?.centiCents ?? 0) / 10_000,
    tokens: { input: tokens?.in ?? 0, output: tokens?.out ?? 0 },
  };
}
